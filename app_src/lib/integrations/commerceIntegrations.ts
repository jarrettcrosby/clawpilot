import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  commerceReadCredentialEligible,
} from '@/lib/integrations/commerceReadRuntime'
import {
  decryptFaireOAuthPendingCredential,
  decryptCommerceCredential,
  encryptFaireOAuthPendingCredential,
  encryptCommerceCredential,
  encryptCommerceWebhookPayload,
  normalizeFaireApplicationId,
  normalizeFaireApplicationSecret,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceEnvironment,
  normalizeCommerceOrganizationId,
  type CommerceEnvironment,
  type CommerceProvider,
  type FaireCommerceCredential,
  type FaireOAuthCommerceCredential,
  type ShopifyCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  buildFaireOAuthAuthorizationUrl,
  exchangeFaireOAuthAuthorizationCode,
  FAIRE_API_SCOPES,
  FaireCommerceClientError,
  probeFaireBrandProfile,
} from '@/lib/integrations/faireCommerceClient'
import {
  auditShopifyScopeUpdatePayload,
  auditShopifyScopeRequirements,
  hasEffectiveShopifyScope,
  SHOPIFY_ADMIN_API_VERSION,
  SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS,
  SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
  SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
  SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
  SHOPIFY_RECEIPT_PROOF_SCOPES,
  SHOPIFY_SCOPE_REFRESH_WEBHOOK_TOPICS,
} from '@/lib/integrations/commerceCapabilities'
import {
  createShopifyWebhookSubscription,
  discoverShopifyWebhookSubscriptions,
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  ShopifyCommerceClientError,
  verifyShopifyWebhookHmac,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  shopifyDeletedProductEvidence,
} from '@/lib/integrations/shopifyCatalogWebhook'
import {
  shopifyInventoryWebhookTargeting,
  type ShopifyInventoryWebhookTargeting,
} from '@/lib/integrations/shopifyInventoryWebhook'
import {
  discoverShopifyOrderWebhookSubscriptions,
  decideShopifyOrderWebhookRecovery,
  isShopifyOrderSignalWebhookTopic,
  reconcileShopifyOrderWebhookSubscriptions,
  shopifyOrderWebhookReconciliationConfirmation,
  shopifyOrderWebhookReconciliationRequestHash,
  shopifyOrderWebhookSignalEvidence,
  SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS,
  SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS,
  ShopifyOrderWebhookDispatchError,
  ShopifyOrderWebhookError,
  type ShopifyOrderWebhookSubscriptionReadiness,
} from '@/lib/integrations/shopifyOrderWebhook'
import {
  assertShopifyOrderPreviewRuntime,
  fetchShopifyOrderPreview,
  normalizeShopifyOrderPreviewIdempotencyKey,
  SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
  SHOPIFY_ORDER_PREVIEW_POLICY_VERSION,
  ShopifyOrderPreviewError,
} from '@/lib/integrations/shopifyOrderPreview'
import {
  claimFaireOAuthInstallationInPostgres,
  createFaireOAuthInstallationInPostgres,
  discardFaireOAuthInstallationInPostgres,
  disconnectCommerceCredentialInPostgres,
  markShopifyWebhookSecretVerifiedInPostgres,
  markCommerceCredentialVerificationInPostgres,
  purgeExpiredFaireOAuthInstallationsInPostgres,
  readCommerceIntegrationsStateFromPostgres,
  readCommerceRuntimeCredentialFromPostgres,
  readCommerceWebhookCredentialFromPostgres,
  recordCommerceCredentialRevealInPostgres,
  recordCommerceProviderAttemptInPostgres,
  recordShopifyWebhookReceiptInPostgres,
  setCommerceIntegrationEnabledInPostgres,
  writeCommerceCredentialInPostgres,
  type CommerceIntegrationsState,
  type CommerceRuntimeCredentialRecord,
  type CommerceSyncResource,
} from '@/lib/persistence/commerceIntegrations'
import {
  clearShopifyOrderPreviewInPostgres,
  purgeExpiredShopifyOrderPreviewsInPostgres,
  readShopifyOrderPreviewStateFromPostgres,
  storeShopifyOrderPreviewInPostgres,
} from '@/lib/persistence/commerceOrderPreviews'
import {
  ShopifyFulfillmentNotificationPolicyError,
  updateShopifyFulfillmentNotificationPolicyInPostgres,
} from '@/lib/persistence/shopifyFulfillmentNotifications'
import {
  recordShopifyOrderWebhookSignalInPostgres,
  ShopifyOrderWebhookSignalPersistenceError,
} from '@/lib/persistence/shopifyOrderWebhookSignals'
import {
  normalizeCommerceOrderHistoryMode,
} from '@/lib/integrations/commerceOrderHistoryPolicy'
import {
  claimShopifyOrderWebhookReconciliationInPostgres,
  failShopifyOrderWebhookPreDispatchInPostgres,
  finalizeShopifyOrderWebhookReconciliationInPostgres,
  markStaleShopifyOrderWebhookAttemptUnknownInPostgres,
  prepareShopifyOrderWebhookReconciliationInPostgres,
  readOpenShopifyOrderWebhookRecoveryKeyInPostgres,
  readShopifyOrderWebhookAttemptIdInPostgres,
  ShopifyOrderWebhookReconciliationPersistenceError,
} from '@/lib/persistence/shopifyOrderWebhookReconciliation'
import { appPublicUrl } from '@/lib/publicUrl'

const SHOPIFY_ADAPTER_VERSION = `shopify-graphql-${SHOPIFY_ADMIN_API_VERSION}-control-v1`
const SHOPIFY_ORDER_PREVIEW_ADAPTER_VERSION =
  `shopify-graphql-${SHOPIFY_ADMIN_API_VERSION}-held-preview-v1`
const FAIRE_ADAPTER_VERSION = 'faire-external-api-v2-control-v1'
const FAIRE_OAUTH_GRANT_ADAPTER_VERSION =
  'faire-external-api-v2-oauth-authorization-code-v1'
const FAIRE_OAUTH_INSTALLATION_TTL_MS = 15 * 60 * 1000
const SHOPIFY_ORDER_PREVIEW_PROVIDER_BUDGET_MS = 50_000
const SHOPIFY_ORDER_PREVIEW_PROVIDER_CALL_TIMEOUT_MS = 10_000
const MAX_WEBHOOK_BYTES = 512 * 1024
const SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET = new Set<string>(
  SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
)

function missingShopifyReceiptProofScopes(grantedScopes: unknown) {
  const granted = Array.isArray(grantedScopes)
    ? grantedScopes.filter(
      (scope): scope is string => typeof scope === 'string',
    )
    : []
  return SHOPIFY_RECEIPT_PROOF_SCOPES.filter(
    (scope) => !hasEffectiveShopifyScope(granted, scope),
  )
}

const SHOPIFY_RECEIPT_SUBSCRIPTION_GROUPS = [
  { key: 'scopeWebhookSubscriptions', label: 'access-scope safety' },
  { key: 'webhookSubscriptions', label: 'inventory freshness' },
  { key: 'catalogWebhookSubscriptions', label: 'product catalog' },
] as const

function missingShopifyReceiptSubscriptionGroups(
  configuration: Record<string, unknown>,
) {
  return SHOPIFY_RECEIPT_SUBSCRIPTION_GROUPS
    .filter(({ key }) => {
      const readiness = configuration[key]
      return !readiness
        || typeof readiness !== 'object'
        || Array.isArray(readiness)
        || (readiness as Record<string, unknown>).ready !== true
    })
    .map(({ label }) => label)
}

export class CommerceIntegrationRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status = 400,
    code = 'COMMERCE_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function sanitize(error: unknown): CommerceIntegrationRequestError {
  if (isIntegrationCredentialRuntimeGateError(error)) throw error
  if (error instanceof CommerceIntegrationRequestError) return error
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && 'status' in error
    && error.code === 'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY'
    && error.status === 409
  ) {
    return new CommerceIntegrationRequestError(
      'Pack confirmation is using this exact evidence; retry after refreshing status',
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyFulfillmentNotificationPolicyError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyOrderWebhookError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyOrderWebhookSignalPersistenceError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyOrderWebhookReconciliationPersistenceError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyCommerceClientError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof FaireCommerceClientError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  if (error instanceof ShopifyOrderPreviewError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  const message = error instanceof Error ? error.message : ''
  if (message === 'Commerce credential encryption is not configured') {
    return new CommerceIntegrationRequestError(
      message,
      503,
      'COMMERCE_ENCRYPTION_UNAVAILABLE',
    )
  }
  if (message === 'Stored commerce credential could not be decrypted') {
    return new CommerceIntegrationRequestError(
      message,
      500,
      'COMMERCE_CREDENTIAL_INVALID',
    )
  }
  if (message === 'Stored Faire OAuth installation could not be decrypted') {
    return new CommerceIntegrationRequestError(
      'Faire OAuth setup could not be validated; start the connection again',
      409,
      'FAIRE_OAUTH_STATE_INVALID',
    )
  }
  if (message === 'The commerce connection is permanently bound to its original provider account') {
    return new CommerceIntegrationRequestError(
      'This sales-channel connection is bound to its original store or brand; account replacement requires a future account-generation workflow',
      409,
      'COMMERCE_ACCOUNT_IDENTITY_CONFLICT',
    )
  }
  if (
    message === 'Commerce fulfillment provider authority is leased by a prepared attempt'
    || message === 'Commerce fulfillment provider account authority cannot drift while leased'
    || message === 'Commerce fulfillment provider credential is leased by a prepared attempt'
    || message === 'Commerce fulfillment provider credential authority cannot drift while leased'
  ) {
    return new CommerceIntegrationRequestError(
      'A fulfillment update is still in progress or awaiting reconciliation; refresh its status before changing this sales-channel connection',
      409,
      'COMMERCE_FULFILLMENT_LEASE_BUSY',
    )
  }
  if (message === 'Shopify reused a webhook event ID with a different payload') {
    return new CommerceIntegrationRequestError(
      'Shopify webhook delivery identity conflicted with prior evidence',
      409,
      'SHOPIFY_WEBHOOK_IDENTITY_CONFLICT',
    )
  }
  if (message === 'Shopify webhook credential generation changed before receipt commit') {
    return new CommerceIntegrationRequestError(
      'Shopify webhook credential changed before the delivery could be recorded',
      409,
      'SHOPIFY_WEBHOOK_CREDENTIAL_STALE',
    )
  }
  if (message === 'Shopify order preview credential changed before preview commit') {
    return new CommerceIntegrationRequestError(
      'The Shopify credential changed before the held preview could be saved',
      409,
      'SHOPIFY_ORDER_PREVIEW_CREDENTIAL_STALE',
    )
  }
  if (message === 'Shopify order preview idempotency key was reused for a different request') {
    return new CommerceIntegrationRequestError(
      'The Shopify order-preview request identity was already used',
      409,
      'SHOPIFY_ORDER_PREVIEW_IDEMPOTENCY_CONFLICT',
    )
  }
  if (
    message.startsWith('Commerce ')
    || message.startsWith('Provider ')
    || message.startsWith('Faire ')
    || message.startsWith('Shopify ')
    || message.startsWith('A valid organization')
    || message.startsWith('Disconnect the existing')
  ) {
    return new CommerceIntegrationRequestError(
      message,
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
  return new CommerceIntegrationRequestError(
    'Commerce integration request failed',
    500,
    'COMMERCE_INTERNAL_ERROR',
  )
}

export function sanitizedCommerceIntegrationError(error: unknown) {
  return sanitize(error)
}

function displayName(value: unknown, fallback: string) {
  const normalized = String(value || fallback).trim().replace(/\s+/g, ' ')
  if (
    !normalized
    || normalized.length > 120
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CommerceIntegrationRequestError(
      'Sales-channel connection name must be 1-120 characters',
    )
  }
  return normalized
}

function optionalDisplayName(value: unknown) {
  const normalized = String(value || '').trim()
  return normalized ? displayName(normalized, normalized) : null
}

function accessToken(value: unknown, provider: 'Faire') {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 8
    || normalized.length > 4096
    || !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new CommerceIntegrationRequestError(
      `A valid ${provider} access token is required`,
    )
  }
  return normalized
}

function clientId(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 8
    || normalized.length > 255
    || !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new CommerceIntegrationRequestError(
      'A valid Shopify app client ID is required',
    )
  }
  return normalized
}

function clientSecret(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 16
    || normalized.length > 4096
    || !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new CommerceIntegrationRequestError(
      'A valid Shopify app client secret is required',
    )
  }
  return normalized
}

function safeText(
  value: unknown,
  label: string,
  maximum = 255,
): string {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized || normalized.length > maximum) {
    throw new CommerceIntegrationRequestError(`${label} is invalid`)
  }
  return normalized
}

function safeProviderId(value: unknown, label: string) {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CommerceIntegrationRequestError(`${label} is invalid`)
  }
  return normalized
}

function faireProfileIdentity(profile: Record<string, unknown>) {
  const id = safeProviderId(
    profile.id || profile.brand_id || profile.brandId,
    'Faire brand identity',
  )
  const name = safeText(
    profile.name || profile.brand_name || profile.brandName,
    'Faire brand name',
  )
  return { id, name }
}

const SHOPIFY_SYNC_RESOURCES: CommerceSyncResource[] = [
  'orders',
  'products',
  'inventory',
  'fulfillments',
  'returns',
]
const FAIRE_SYNC_RESOURCES: CommerceSyncResource[] = [
  'orders',
  'products',
  'inventory',
  'shipments',
  'returns',
]

function webhookUrl(globalId: string, publicUrl = appPublicUrl()) {
  return new URL(
    `/api/integrations/commerce/shopify/webhooks/${globalId}`,
    publicUrl,
  ).toString()
}

export type CommerceIntegrationsViewState = Omit<
  CommerceIntegrationsState,
  'accounts'
> & {
  accounts: Array<CommerceIntegrationsState['accounts'][number] & {
    webhookUrl: string | null
  }>
}

export function createCommerceIntegrationsStateProjector(): (
  state: CommerceIntegrationsState,
) => CommerceIntegrationsViewState {
  const publicUrl = appPublicUrl()
  return (state) => ({
    ...state,
    accounts: state.accounts.map((account) => ({
      ...account,
      webhookUrl: account.provider === 'shopify'
        ? webhookUrl(account.globalId, publicUrl)
        : null,
    })),
  })
}

export function faireOAuthCallbackUrl() {
  return new URL(
    '/api/integrations/commerce/faire/oauth/callback',
    appPublicUrl(),
  ).toString()
}

function requireFaireOAuthHttpsCallback(redirectUrl: string) {
  if (new URL(redirectUrl).protocol !== 'https:') {
    throw new CommerceIntegrationRequestError(
      'Faire OAuth requires ClawPilot to run at a configured public HTTPS origin',
      503,
      'FAIRE_OAUTH_PUBLIC_HTTPS_REQUIRED',
    )
  }
  return redirectUrl
}

function faireOAuthState(value: unknown) {
  const state = String(value || '').trim()
  if (
    state.length < 32
    || state.length > 256
    || !/^[A-Za-z0-9_-]+$/.test(state)
  ) {
    throw new CommerceIntegrationRequestError(
      'Faire OAuth state is invalid or expired',
      409,
      'FAIRE_OAUTH_STATE_INVALID',
    )
  }
  return state
}

function faireOAuthRequestedScopes(value: unknown) {
  if (value === undefined || value === 'connection_test') {
    return ['READ_BRAND']
  }
  if (value === 'distributed_operations') {
    return [...FAIRE_API_SCOPES]
  }
  throw new CommerceIntegrationRequestError(
    'Faire OAuth scope profile is invalid',
    400,
    'FAIRE_OAUTH_SCOPE_PROFILE_INVALID',
  )
}

export async function startFaireOAuthCommerce(input: {
  organizationId: unknown
  browserSessionId: string
  actorEmail: string
  displayName?: unknown
  applicationId: unknown
  applicationSecret: unknown
  scopeProfile?: unknown
  orderHistoryMode?: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const applicationId = normalizeFaireApplicationId(input.applicationId)
    const applicationSecret = normalizeFaireApplicationSecret(
      input.applicationSecret,
    )
    const state = randomBytes(32).toString('base64url')
    const stateHash = createHash('sha256').update(state).digest('hex')
    const redirectUrl = requireFaireOAuthHttpsCallback(
      faireOAuthCallbackUrl(),
    )
    const requestedScopes = faireOAuthRequestedScopes(input.scopeProfile)
    const orderHistoryMode = normalizeCommerceOrderHistoryMode(
      input.orderHistoryMode,
      'faire',
    )
    const expiresAt = new Date(
      Date.now() + FAIRE_OAUTH_INSTALLATION_TTL_MS,
    ).toISOString()
    const encrypted = encryptFaireOAuthPendingCredential(
      { applicationId, applicationSecret },
      organizationId,
      input.browserSessionId,
      stateHash,
    )
    await purgeExpiredFaireOAuthInstallationsInPostgres()
    await createFaireOAuthInstallationInPostgres({
      organizationId,
      browserSessionId: input.browserSessionId,
      actorEmail: input.actorEmail,
      stateHash,
      redirectUrl,
      displayName: optionalDisplayName(input.displayName),
      requestedScopes,
      orderHistoryMode,
      applicationIdLastFour: applicationId.slice(-4),
      encrypted,
      expiresAt,
    })
    return {
      authorizationUrl: buildFaireOAuthAuthorizationUrl({
        applicationId,
        redirectUrl,
        scopes: requestedScopes,
        state,
      }),
      callbackUrl: redirectUrl,
      expiresAt,
      requestedScopes,
    }
  } catch (error) {
    throw sanitize(error)
  }
}

export async function purgeExpiredFaireOAuthCommerce() {
  try {
    assertIntegrationCredentialProviderIoReady()
    return await purgeExpiredFaireOAuthInstallationsInPostgres()
  } catch (error) {
    throw sanitize(error)
  }
}

export async function discardFaireOAuthCommerce(input: {
  organizationId: unknown
  browserSessionId: string
  actorEmail: string
  state: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const state = faireOAuthState(input.state)
    const stateHash = createHash('sha256').update(state).digest('hex')
    return await discardFaireOAuthInstallationInPostgres({
      organizationId,
      browserSessionId: input.browserSessionId,
      actorEmail: input.actorEmail,
      stateHash,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function completeFaireOAuthCommerce(input: {
  organizationId: unknown
  browserSessionId: string
  actorEmail: string
  state: unknown
  authorizationCode: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const state = faireOAuthState(input.state)
    const stateHash = createHash('sha256').update(state).digest('hex')
    const pending = await claimFaireOAuthInstallationInPostgres({
      organizationId,
      browserSessionId: input.browserSessionId,
      actorEmail: input.actorEmail,
      stateHash,
    })
    if (!pending) {
      throw new CommerceIntegrationRequestError(
        'Faire OAuth setup is invalid, expired, already used, or belongs to another session',
        409,
        'FAIRE_OAUTH_STATE_INVALID',
      )
    }
    const application = decryptFaireOAuthPendingCredential(
      pending.encrypted,
      pending.organizationId,
      pending.browserSessionId,
      pending.stateHash,
    )
    const exchangeRequestedAt = new Date().toISOString()
    const grant = await exchangeFaireOAuthAuthorizationCode({
      applicationId: application.applicationId,
      applicationSecret: application.applicationSecret,
      authorizationCode: input.authorizationCode,
      redirectUrl: pending.redirectUrl,
      scopes: pending.requestedScopes,
      state,
    })
    const exchangeCompletedAt = new Date().toISOString()
    const credentialFingerprintSha256 = createHash('sha256')
      .update(grant.accessToken)
      .digest('hex')
    const profile = await probeFaireBrandProfile({
      accessToken: grant.accessToken,
      applicationId: application.applicationId,
      applicationSecret: application.applicationSecret,
    })
    const identity = faireProfileIdentity(profile)
    const credential: FaireOAuthCommerceCredential = {
      provider: 'faire',
      authMode: 'faire_oauth',
      applicationId: application.applicationId,
      applicationSecret: application.applicationSecret,
      accessToken: grant.accessToken,
      scopes: pending.requestedScopes,
    }
    const configuration = {
      classification: 'b2b_wholesale_marketplace_sales_channel',
      accountName: identity.name,
      providerAccountId: identity.id,
      adapterVersion: FAIRE_ADAPTER_VERSION,
      apiVersion: 'external-api-v2',
      authMode: credential.authMode,
      tokenAcquisition: 'authorization_code',
      tokenRefreshAvailable: false,
      providerAvailableScopes: [...FAIRE_API_SCOPES],
      requestedScopes: pending.requestedScopes,
      scopeProfile: pending.requestedScopes.length === 1
        && pending.requestedScopes[0] === 'READ_BRAND'
        ? 'connection_test'
        : 'distributed_operations',
      grantedScopes: [...pending.requestedScopes],
      scopeVerification: 'oauth_grant',
      oauthGrantTokenType: grant.tokenType,
      webhooksAvailable: false,
      sandboxAvailable: false,
      returnWritesAvailable: false,
      domainWorkersActivated: false,
    }
    const encrypted = encryptCommerceCredential(
      credential,
      organizationId,
      'production',
      identity.id,
    )
    return writeCommerceCredentialInPostgres({
      organizationId,
      provider: 'faire',
      environment: 'production',
      externalAccountId: identity.id,
      displayName: displayName(pending.displayName, identity.name),
      configuration,
      authMode: credential.authMode,
      encrypted,
      credentialIdentifierLastFour: application.applicationId.slice(-4),
      webhookVerificationStatus: 'not_applicable',
      resources: FAIRE_SYNC_RESOURCES,
      actorEmail: input.actorEmail,
      orderHistoryMode: pending.orderHistoryMode,
      faireOAuthGrant: {
        requestedScopes: [...pending.requestedScopes],
        tokenType: grant.tokenType,
        credentialFingerprintSha256,
        requestedAt: exchangeRequestedAt,
        completedAt: exchangeCompletedAt,
        adapterVersion: FAIRE_OAUTH_GRANT_ADAPTER_VERSION,
      },
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function getCommerceIntegrationsState(
  organizationIdValue: unknown,
) {
  assertIntegrationCredentialProviderIoReady()
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const project = createCommerceIntegrationsStateProjector()
  await purgeExpiredShopifyOrderPreviewsInPostgres()
  const state = await readCommerceIntegrationsStateFromPostgres(organizationId)
  return project(state)
}

export async function revealCommerceCredential(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  try {
    const runtime = await storedRuntime(input)
    const credential = decryptStoredCredential(runtime)
    let revealable:
      | {
          clientId: string
          clientSecret: string
        }
      | {
          applicationId: string
          applicationSecret: string
        }
    if (
      runtime.provider === 'shopify'
      && credential.provider === 'shopify'
      && credential.authMode === 'shopify_client_credentials'
    ) {
      revealable = {
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      }
    } else if (
      runtime.provider === 'faire'
      && credential.provider === 'faire'
      && credential.authMode === 'faire_oauth'
    ) {
      revealable = {
        applicationId: credential.applicationId,
        applicationSecret: credential.applicationSecret,
      }
    } else {
      throw new CommerceIntegrationRequestError(
        'This Faire connection does not store an application ID and Secret ID',
        409,
        'COMMERCE_CREDENTIAL_REVEAL_UNAVAILABLE',
      )
    }
    await recordCommerceCredentialRevealInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      actorEmail: input.actorEmail,
      credentialVersion: runtime.credentialVersion,
    })
    const revealedAt = new Date()
    return {
      provider: runtime.provider,
      environment: runtime.environment,
      accountGlobalId: runtime.globalId,
      authMode: runtime.authMode,
      credentialVersion: runtime.credentialVersion,
      ...revealable,
      revealedAt: revealedAt.toISOString(),
      expiresAt: new Date(revealedAt.getTime() + 30_000).toISOString(),
    }
  } catch (error) {
    throw sanitize(error)
  }
}

export async function connectShopifyCommerce(input: {
  organizationId: unknown
  environment: unknown
  displayName?: unknown
  shopDomain: unknown
  clientId: unknown
  clientSecret: unknown
  actorEmail: string
  orderHistoryMode?: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const orderHistoryMode = normalizeCommerceOrderHistoryMode(
      input.orderHistoryMode,
      'shopify',
    )
    const environment = normalizeCommerceEnvironment(
      input.environment,
      'shopify',
    )
    const appClientId = clientId(input.clientId)
    const secret = clientSecret(input.clientSecret)
    const shopDomain = normalizeShopifyShopDomain(input.shopDomain)
    const grant = await requestShopifyAccessToken({
      shopDomain,
      clientId: appClientId,
      clientSecret: secret,
    })
    const probe = await probeShopifyConnection(
      {
        shopDomain,
        accessToken: grant.accessToken,
      },
      { resolveCanonicalShopDomain: true },
    )
    const scopeAudit = auditShopifyScopeRequirements(
      SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
      probe.grantedScopes,
    )
    const credential: ShopifyCommerceCredential = {
      provider: 'shopify',
      authMode: 'shopify_client_credentials',
      clientId: appClientId,
      clientSecret: secret,
    }
    const configuration = {
      classification: 'commerce_sales_channel',
      accountName: probe.shopName,
      providerAccountId: probe.shopId,
      shopDomain: probe.shopDomain,
      submittedShopDomain: shopDomain,
      shopDomainResolvedFromAlias: probe.shopDomain !== shopDomain,
      adapterVersion: SHOPIFY_ADAPTER_VERSION,
      apiVersion: probe.apiVersion,
      authMode: credential.authMode,
      grantedScopes: probe.grantedScopes,
      tokenGrantedScopes: grant.grantedScopes,
      tokenAcquisition: 'client_credentials',
      accessTokenLifetimeSeconds: grant.expiresIn,
      accessTokenPersisted: false,
      scopeProfile: 'distributed_operations_v1',
      requestedScopes: scopeAudit.requestedScopes,
      missingScopes: scopeAudit.missingScopes,
      restrictedScopes: scopeAudit.restrictedScopes,
      acceptedReceiptTopics: [...SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS],
      webhookSecretVerified: false,
      domainWorkersActivated: false,
    }
    const encrypted = encryptCommerceCredential(
      credential,
      organizationId,
      environment,
      probe.shopId,
    )
    return writeCommerceCredentialInPostgres({
      organizationId,
      provider: 'shopify',
      environment,
      externalAccountId: probe.shopId,
      displayName: displayName(input.displayName, probe.shopName),
      configuration,
      authMode: credential.authMode,
      encrypted,
      credentialIdentifierLastFour: appClientId.slice(-4),
      webhookVerificationStatus: 'unverified',
      resources: SHOPIFY_SYNC_RESOURCES,
      actorEmail: input.actorEmail,
      orderHistoryMode,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function connectFaireCommerce(input: {
  organizationId: unknown
  displayName?: unknown
  accessToken: unknown
  actorEmail: string
  orderHistoryMode?: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const orderHistoryMode = normalizeCommerceOrderHistoryMode(
      input.orderHistoryMode,
      'faire',
    )
    const environment: CommerceEnvironment = 'production'
    const token = accessToken(input.accessToken, 'Faire')
    const profile = await probeFaireBrandProfile({ accessToken: token })
    const identity = faireProfileIdentity(profile)
    const credential: FaireCommerceCredential = {
      provider: 'faire',
      authMode: 'faire_brand_token',
      accessToken: token,
    }
    const configuration = {
      classification: 'b2b_wholesale_marketplace_sales_channel',
      accountName: identity.name,
      providerAccountId: identity.id,
      adapterVersion: FAIRE_ADAPTER_VERSION,
      apiVersion: 'external-api-v2',
      authMode: credential.authMode,
      providerAvailableScopes: [...FAIRE_API_SCOPES],
      grantedScopes: null,
      scopeVerification: 'not_exposed_by_provider',
      webhooksAvailable: false,
      sandboxAvailable: false,
      returnWritesAvailable: false,
      domainWorkersActivated: false,
    }
    const encrypted = encryptCommerceCredential(
      credential,
      organizationId,
      environment,
      identity.id,
    )
    return writeCommerceCredentialInPostgres({
      organizationId,
      provider: 'faire',
      environment,
      externalAccountId: identity.id,
      displayName: displayName(input.displayName, identity.name),
      configuration,
      authMode: credential.authMode,
      encrypted,
      credentialIdentifierLastFour: token.slice(-4),
      webhookVerificationStatus: 'not_applicable',
      resources: FAIRE_SYNC_RESOURCES,
      actorEmail: input.actorEmail,
      orderHistoryMode,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

function decryptStoredCredential(runtime: CommerceRuntimeCredentialRecord) {
  return decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
}

function attemptHash(runtime: CommerceRuntimeCredentialRecord) {
  return createHash('sha256')
    .update(JSON.stringify({
      accountGlobalId: runtime.globalId,
      provider: runtime.provider,
      environment: runtime.environment,
      credentialVersion: runtime.credentialVersion,
    }))
    .digest('hex')
}

function revokesCredentialVerification(
  error: unknown,
  sanitized: CommerceIntegrationRequestError,
) {
  if (
    error instanceof ShopifyCommerceClientError
    || error instanceof FaireCommerceClientError
  ) {
    if (error.retryable) return false
  }
  return new Set([
    'SHOPIFY_ACCESS_DENIED',
    'SHOPIFY_APP_NOT_INSTALLED',
    'SHOPIFY_CLIENT_CREDENTIALS_REJECTED',
    'SHOPIFY_SHOP_NOT_PERMITTED',
    'SHOPIFY_STORE_NOT_FOUND',
    'SHOPIFY_PROBE_INVALID',
    'SHOPIFY_CANONICAL_DOMAIN_REQUIRED',
    'SHOPIFY_STORE_IDENTITY_CHANGED',
    'FAIRE_ACCESS_DENIED',
    'FAIRE_RESOURCE_NOT_FOUND',
    'FAIRE_BRAND_IDENTITY_CHANGED',
    'COMMERCE_CREDENTIAL_INVALID',
  ]).has(sanitized.code)
}

async function storedRuntime(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId,
    accountGlobalId,
  })
  if (!runtime) {
    throw new CommerceIntegrationRequestError(
      'Commerce credentials are not configured',
      404,
      'COMMERCE_CREDENTIAL_REQUIRED',
    )
  }
  return runtime
}

async function shopifyPreviewAccount(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const runtime = await storedRuntime(input)
  if (runtime.provider !== 'shopify') {
    throw new CommerceIntegrationRequestError(
      'Shopify order preview requires a Shopify sales channel',
      400,
      'SHOPIFY_ORDER_PREVIEW_PROVIDER_REQUIRED',
    )
  }
  return runtime
}

async function shopifyPreviewFetchRuntime(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  assertShopifyOrderPreviewRuntime()
  const runtime = await shopifyPreviewAccount(input)
  if (runtime.environment !== 'sandbox') {
    throw new CommerceIntegrationRequestError(
      'Shopify order preview is limited to development or test stores',
      409,
      'SHOPIFY_ORDER_PREVIEW_SANDBOX_REQUIRED',
    )
  }
  if (runtime.verificationStatus !== 'verified' || runtime.status === 'error') {
    throw new CommerceIntegrationRequestError(
      'Verify the Shopify connection before reading an order preview',
      409,
      'SHOPIFY_ORDER_PREVIEW_VERIFICATION_REQUIRED',
    )
  }
  return runtime
}

function shopifyPreviewProviderTimeout(deadlineAt: number) {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs < 1_000) {
    throw new ShopifyOrderPreviewError(
      'Shopify order preview exceeded its safe read deadline',
      504,
      'SHOPIFY_ORDER_PREVIEW_DEADLINE_EXCEEDED',
    )
  }
  return Math.min(
    SHOPIFY_ORDER_PREVIEW_PROVIDER_CALL_TIMEOUT_MS,
    remainingMs,
  )
}

export async function getShopifyOrderPreview(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  try {
    const runtime = await shopifyPreviewAccount(input)
    return readShopifyOrderPreviewStateFromPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function clearShopifyOrderPreview(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const runtime = await shopifyPreviewAccount(input)
    return clearShopifyOrderPreviewInPostgres({
      runtime,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function importShopifyOrderPreview(input: {
  organizationId: unknown
  accountGlobalId: unknown
  idempotencyKey: unknown
  actorEmail: string
}) {
  let runtime: CommerceRuntimeCredentialRecord | null = null
  const requestedAt = new Date()
  const idempotencyKey = normalizeShopifyOrderPreviewIdempotencyKey(
    input.idempotencyKey,
  )
  try {
    assertIntegrationCredentialProviderIoReady()
    runtime = await shopifyPreviewFetchRuntime(input)
    const providerDeadlineAt =
      Date.now() + SHOPIFY_ORDER_PREVIEW_PROVIDER_BUDGET_MS
    const credential = decryptStoredCredential(runtime)
    if (credential.provider !== 'shopify') {
      throw new Error('Stored commerce credential could not be decrypted')
    }
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    const grant = await requestShopifyAccessToken(
      {
        shopDomain,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      },
      { timeoutMs: shopifyPreviewProviderTimeout(providerDeadlineAt) },
    )
    const probe = await probeShopifyConnection(
      {
        shopDomain,
        accessToken: grant.accessToken,
      },
      { timeoutMs: shopifyPreviewProviderTimeout(providerDeadlineAt) },
    )
    if (probe.shopId !== runtime.externalAccountId) {
      throw new CommerceIntegrationRequestError(
        'Shopify returned a different store identity',
        409,
        'SHOPIFY_STORE_IDENTITY_CHANGED',
      )
    }
    if (
      !hasEffectiveShopifyScope(probe.grantedScopes, 'read_orders')
      || !hasEffectiveShopifyScope(grant.grantedScopes, 'read_orders')
    ) {
      throw new CommerceIntegrationRequestError(
        'The installed Shopify app has not granted read_orders',
        409,
        'SHOPIFY_ORDER_READ_SCOPE_REQUIRED',
      )
    }
    const fetched = await fetchShopifyOrderPreview(
      {
        shopDomain,
        accessToken: grant.accessToken,
      },
      { deadlineAt: providerDeadlineAt },
    )
    const requestHash = createHash('sha256').update(JSON.stringify({
      accountGlobalId: runtime.globalId,
      credentialVersion: runtime.credentialVersion,
      policyVersion: SHOPIFY_ORDER_PREVIEW_POLICY_VERSION,
      maxOrders: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
      testOrdersIncluded: false,
      shopifyWrites: 0,
    })).digest('hex')
    const state = await storeShopifyOrderPreviewInPostgres({
      runtime,
      idempotencyKey,
      requestHash,
      grantedScopes: probe.grantedScopes,
      fetched,
      actorEmail: input.actorEmail,
    })
    const completedAt = new Date()
    await recordCommerceProviderAttemptInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      action: 'orders.held_preview.read',
      adapterVersion: SHOPIFY_ORDER_PREVIEW_ADAPTER_VERSION,
      idempotencyKey,
      requestHash,
      redactedRequest: {
        credentialVersion: runtime.credentialVersion,
        policyVersion: SHOPIFY_ORDER_PREVIEW_POLICY_VERSION,
        maxOrders: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
        includeTestOrders: false,
        readOnly: true,
      },
      redactedResponse: {
        ordersSeen: fetched.ordersSeen,
        ordersStaged: fetched.candidates.length,
        moreAvailable: fetched.moreAvailable,
        canonicalOrdersCreated: 0,
        shopifyWrites: 0,
        syncCursorAdvanced: false,
      },
      state: 'succeeded',
      providerReference: runtime.externalAccountId,
      errorCode: null,
      actorEmail: input.actorEmail,
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    })
    return state
  } catch (error) {
    const sanitized = sanitize(error)
    if (runtime) {
      const completedAt = new Date()
      await recordCommerceProviderAttemptInPostgres({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
        action: 'orders.held_preview.read',
        adapterVersion: SHOPIFY_ORDER_PREVIEW_ADAPTER_VERSION,
        idempotencyKey,
        requestHash: createHash('sha256').update(JSON.stringify({
          accountGlobalId: runtime.globalId,
          credentialVersion: runtime.credentialVersion,
          policyVersion: SHOPIFY_ORDER_PREVIEW_POLICY_VERSION,
          maxOrders: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
          testOrdersIncluded: false,
          shopifyWrites: 0,
        })).digest('hex'),
        redactedRequest: {
          credentialVersion: runtime.credentialVersion,
          policyVersion: SHOPIFY_ORDER_PREVIEW_POLICY_VERSION,
          maxOrders: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
          includeTestOrders: false,
          readOnly: true,
        },
        redactedResponse: {},
        state: 'failed',
        providerReference: runtime.externalAccountId,
        errorCode: sanitized.code,
        actorEmail: input.actorEmail,
        requestedAt: requestedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      }).catch(() => undefined)
    }
    throw sanitized
  }
}

async function verifyStoredConnection(
  runtime: CommerceRuntimeCredentialRecord,
): Promise<{
  configuration: Record<string, unknown>
  providerReference: string
  response: Record<string, unknown>
}> {
  const credential = decryptStoredCredential(runtime)
  if (runtime.provider === 'shopify') {
    if (credential.provider !== 'shopify') {
      throw new Error('Stored commerce credential could not be decrypted')
    }
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
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
    if (probe.shopId !== runtime.externalAccountId) {
      throw new CommerceIntegrationRequestError(
        'Shopify returned a different store identity',
        409,
        'SHOPIFY_STORE_IDENTITY_CHANGED',
      )
    }
    const scopeAudit = auditShopifyScopeRequirements(
      SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
      probe.grantedScopes,
    )
    const scopeWebhookSubscriptions = await discoverShopifyWebhookSubscriptions(
      { shopDomain, accessToken: grant.accessToken },
      {
        desiredUri: webhookUrl(runtime.globalId),
        topics: SHOPIFY_SCOPE_REFRESH_WEBHOOK_TOPICS,
      },
    )
    const webhookSubscriptions = await discoverShopifyWebhookSubscriptions(
      { shopDomain, accessToken: grant.accessToken },
      {
        desiredUri: webhookUrl(runtime.globalId),
        topics: SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
      },
    )
    const catalogWebhookSubscriptions = await discoverShopifyWebhookSubscriptions(
      { shopDomain, accessToken: grant.accessToken },
      {
        desiredUri: webhookUrl(runtime.globalId),
        topics: SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS,
      },
    )
    let orderWebhookSubscriptions: (
      ShopifyOrderWebhookSubscriptionReadiness & {
        discoveryState: 'succeeded'
        discoveryErrorCode: null
      }
    ) | {
      desiredUri: string
      requiredTopics: typeof SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS[number][]
      requiredIncludeFields: string[]
      subscriptions: []
      matchingTopics: []
      missingTopics: typeof SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS[number][]
      conflictingTopics: []
      ready: false
      processorState: 'available'
      providerWrites: 0
      discoveryState: 'failed'
      discoveryErrorCode: string
    }
    try {
      orderWebhookSubscriptions = {
        ...(await discoverShopifyOrderWebhookSubscriptions(
          { shopDomain, accessToken: grant.accessToken },
          { desiredUri: webhookUrl(runtime.globalId) },
        )),
        discoveryState: 'succeeded',
        discoveryErrorCode: null,
      }
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
      const code = error instanceof ShopifyCommerceClientError
        || error instanceof ShopifyOrderWebhookError
        ? error.code
        : 'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_FAILED'
      orderWebhookSubscriptions = {
        desiredUri: webhookUrl(runtime.globalId),
        requiredTopics: [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS],
        requiredIncludeFields: [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS],
        subscriptions: [],
        matchingTopics: [],
        missingTopics: [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS],
        conflictingTopics: [],
        ready: false,
        processorState: 'available',
        providerWrites: 0,
        discoveryState: 'failed',
        discoveryErrorCode: code,
      }
    }
    const orderWebhookObservedAt = new Date().toISOString()
    return {
      configuration: {
        ...runtime.configuration,
        accountName: probe.shopName,
        shopDomain: probe.shopDomain,
        adapterVersion: SHOPIFY_ADAPTER_VERSION,
        apiVersion: probe.apiVersion,
        grantedScopes: probe.grantedScopes,
        tokenGrantedScopes: grant.grantedScopes,
        tokenAcquisition: 'client_credentials',
        accessTokenLifetimeSeconds: grant.expiresIn,
        accessTokenPersisted: false,
        scopeProfile: 'distributed_operations_v1',
        requestedScopes: scopeAudit.requestedScopes,
        missingScopes: scopeAudit.missingScopes,
        restrictedScopes: scopeAudit.restrictedScopes,
        scopeWebhookSubscriptions: {
          desiredUri: scopeWebhookSubscriptions.desiredUri,
          requiredTopics: scopeWebhookSubscriptions.requiredTopics,
          observedCount: scopeWebhookSubscriptions.subscriptions.length,
          matchingCount: scopeWebhookSubscriptions.subscriptions.filter(
            (subscription) => subscription.uri
              === scopeWebhookSubscriptions.desiredUri,
          ).length,
          missingTopics: scopeWebhookSubscriptions.missingTopics,
          conflictingTopics: scopeWebhookSubscriptions.conflictingTopics,
          ready: scopeWebhookSubscriptions.ready,
          observedAt: new Date().toISOString(),
          providerWrites: 0,
        },
        webhookSubscriptions: {
          accountGlobalId: runtime.globalId,
          credentialGeneration: runtime.credentialVersion,
          desiredUri: webhookSubscriptions.desiredUri,
          requiredTopics: webhookSubscriptions.requiredTopics,
          observedCount: webhookSubscriptions.subscriptions.length,
          matchingCount: webhookSubscriptions.subscriptions.filter(
            (subscription) => subscription.uri === webhookSubscriptions.desiredUri,
          ).length,
          missingTopics: webhookSubscriptions.missingTopics,
          conflictingTopics: webhookSubscriptions.conflictingTopics,
          ready: webhookSubscriptions.ready,
          observedAt: new Date().toISOString(),
          discoveryState: 'succeeded',
          discoveryErrorCode: null,
          providerWrites: 0,
        },
        catalogWebhookSubscriptions: {
          desiredUri: catalogWebhookSubscriptions.desiredUri,
          requiredTopics: catalogWebhookSubscriptions.requiredTopics,
          observedCount: catalogWebhookSubscriptions.subscriptions.length,
          matchingCount: catalogWebhookSubscriptions.subscriptions.filter(
            (subscription) => subscription.uri
              === catalogWebhookSubscriptions.desiredUri,
          ).length,
          missingTopics: catalogWebhookSubscriptions.missingTopics,
          conflictingTopics: catalogWebhookSubscriptions.conflictingTopics,
          ready: catalogWebhookSubscriptions.ready,
          observedAt: new Date().toISOString(),
          providerWrites: 0,
        },
        orderWebhookSubscriptions: {
          accountGlobalId: runtime.globalId,
          credentialGeneration: runtime.credentialVersion,
          desiredUri: orderWebhookSubscriptions.desiredUri,
          requiredTopics: orderWebhookSubscriptions.requiredTopics,
          requiredIncludeFields:
            orderWebhookSubscriptions.requiredIncludeFields,
          observedCount: orderWebhookSubscriptions.subscriptions.length,
          matchingCount: orderWebhookSubscriptions.matchingTopics.length,
          missingTopics: orderWebhookSubscriptions.missingTopics,
          conflictingTopics: orderWebhookSubscriptions.conflictingTopics,
          subscriptionReady: orderWebhookSubscriptions.ready,
          processorState: orderWebhookSubscriptions.processorState,
          exactReadProcessorReady: true,
          scheduledPollBackstop: true,
          ready: orderWebhookSubscriptions.ready,
          observedAt: orderWebhookObservedAt,
          discoveryState: orderWebhookSubscriptions.discoveryState,
          discoveryErrorCode: orderWebhookSubscriptions.discoveryErrorCode,
          providerWrites: 0,
        },
        lastVerifiedAt: new Date().toISOString(),
        domainWorkersActivated: false,
      },
      providerReference: probe.shopId,
      response: {
        shopId: probe.shopId,
        shopDomain: probe.shopDomain,
        grantedScopeCount: probe.grantedScopes.length,
        tokenLifetimeSeconds: grant.expiresIn,
        scopeWebhookSubscriptionReady: scopeWebhookSubscriptions.ready,
        scopeWebhookSubscriptionObservedCount:
          scopeWebhookSubscriptions.subscriptions.length,
        scopeWebhookSubscriptionMissingCount:
          scopeWebhookSubscriptions.missingTopics.length,
        scopeWebhookSubscriptionConflictingCount:
          scopeWebhookSubscriptions.conflictingTopics.length,
        webhookSubscriptionReady: webhookSubscriptions.ready,
        webhookSubscriptionObservedCount: webhookSubscriptions.subscriptions.length,
        webhookSubscriptionMissingCount: webhookSubscriptions.missingTopics.length,
        webhookSubscriptionConflictingCount: webhookSubscriptions.conflictingTopics.length,
        catalogWebhookSubscriptionReady: catalogWebhookSubscriptions.ready,
        catalogWebhookSubscriptionObservedCount:
          catalogWebhookSubscriptions.subscriptions.length,
        catalogWebhookSubscriptionMissingCount:
          catalogWebhookSubscriptions.missingTopics.length,
        orderWebhookSubscriptionReady: orderWebhookSubscriptions.ready,
        orderWebhookSubscriptionObservedCount:
          orderWebhookSubscriptions.subscriptions.length,
        orderWebhookSubscriptionMatchingCount:
          orderWebhookSubscriptions.matchingTopics.length,
        orderWebhookSubscriptionMissingCount:
          orderWebhookSubscriptions.missingTopics.length,
        orderWebhookSubscriptionConflictingCount:
          orderWebhookSubscriptions.conflictingTopics.length,
        orderWebhookExactReadProcessorReady: true,
        orderWebhookDiscoveryState:
          orderWebhookSubscriptions.discoveryState,
        orderWebhookDiscoveryErrorCode:
          orderWebhookSubscriptions.discoveryErrorCode,
        providerWrites: 0,
      },
    }
  }
  if (credential.provider !== 'faire') {
    throw new Error('Stored commerce credential could not be decrypted')
  }
  const profile = await probeFaireBrandProfile(
    credential.authMode === 'faire_oauth'
      ? {
          accessToken: credential.accessToken,
          applicationId: credential.applicationId,
          applicationSecret: credential.applicationSecret,
        }
      : { accessToken: credential.accessToken },
  )
  const identity = faireProfileIdentity(profile)
  if (identity.id !== runtime.externalAccountId) {
    throw new CommerceIntegrationRequestError(
      'Faire returned a different brand identity',
      409,
      'FAIRE_BRAND_IDENTITY_CHANGED',
    )
  }
  const recordedGrantedScopes = Array.isArray(
    runtime.configuration.grantedScopes,
  )
    ? runtime.configuration.grantedScopes.filter(
        (scope): scope is string => typeof scope === 'string',
      )
    : []
  const recordedScopeVerification = credential.authMode === 'faire_oauth'
    && runtime.configuration.scopeVerification === 'oauth_grant'
    && recordedGrantedScopes.length > 0
    ? 'oauth_grant'
    : 'not_exposed_by_provider'
  return {
    configuration: {
      ...runtime.configuration,
      accountName: identity.name,
      adapterVersion: FAIRE_ADAPTER_VERSION,
      apiVersion: 'external-api-v2',
      lastVerifiedAt: new Date().toISOString(),
      domainWorkersActivated: false,
    },
    providerReference: identity.id,
    response: {
      brandId: identity.id,
      brandName: identity.name,
      scopeVerification: recordedScopeVerification,
      grantedScopeCount: recordedGrantedScopes.length,
      scopeEvidenceRefreshed: false,
    },
  }
}

export async function testCommerceConnection(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  let runtime: CommerceRuntimeCredentialRecord | null = null
  const requestedAt = new Date()
  const idempotencyKey = randomUUID()
  try {
    assertIntegrationCredentialProviderIoReady()
    runtime = await storedRuntime(input)
    const verified = await verifyStoredConnection(runtime)
    const completedAt = new Date()
    await recordCommerceProviderAttemptInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      action: 'connection.verify',
      adapterVersion: runtime.provider === 'shopify'
        ? SHOPIFY_ADAPTER_VERSION
        : FAIRE_ADAPTER_VERSION,
      idempotencyKey,
      requestHash: attemptHash(runtime),
      redactedRequest: {
        accountGlobalId: runtime.globalId,
        credentialVersion: runtime.credentialVersion,
      },
      redactedResponse: verified.response,
      state: 'succeeded',
      providerReference: verified.providerReference,
      errorCode: null,
      actorEmail: input.actorEmail,
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    })
    return markCommerceCredentialVerificationInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      credentialVersion: runtime.credentialVersion,
      actorEmail: input.actorEmail,
      errorCode: null,
      configuration: verified.configuration,
      holdReceiptIntake: runtime.provider === 'shopify'
        && missingShopifyReceiptProofScopes(
          verified.configuration.grantedScopes,
        ).length > 0,
    })
  } catch (error) {
    const sanitized = sanitize(error)
    if (runtime) {
      const completedAt = new Date()
      await recordCommerceProviderAttemptInPostgres({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
        action: 'connection.verify',
        adapterVersion: runtime.provider === 'shopify'
          ? SHOPIFY_ADAPTER_VERSION
          : FAIRE_ADAPTER_VERSION,
        idempotencyKey,
        requestHash: attemptHash(runtime),
        redactedRequest: {
          accountGlobalId: runtime.globalId,
          credentialVersion: runtime.credentialVersion,
        },
        redactedResponse: {},
        state: 'failed',
        providerReference: null,
        errorCode: sanitized.code,
        actorEmail: input.actorEmail,
        requestedAt: requestedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      }).catch(() => undefined)
      if (revokesCredentialVerification(error, sanitized)) {
        await markCommerceCredentialVerificationInPostgres({
          organizationId: runtime.organizationId,
          accountGlobalId: runtime.globalId,
          credentialVersion: runtime.credentialVersion,
          actorEmail: input.actorEmail,
          errorCode: sanitized.code,
        }).catch(() => undefined)
      }
    }
    throw sanitized
  }
}

async function registerShopifyWebhookSubscriptionGroup(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
  group: 'scope' | 'inventory' | 'catalog'
}) {
  let runtime: CommerceRuntimeCredentialRecord | null = null
  const requestedAt = new Date()
  const idempotencyKey = randomUUID()
  try {
    assertIntegrationCredentialProviderIoReady()
    runtime = await storedRuntime(input)
    if (runtime.provider !== 'shopify') {
      throw new CommerceIntegrationRequestError(
        'Webhook registration requires a Shopify sales channel',
        400,
        'SHOPIFY_WEBHOOK_PROVIDER_REQUIRED',
      )
    }
    if (runtime.verificationStatus !== 'verified' || runtime.status !== 'active') {
      throw new CommerceIntegrationRequestError(
        'Verify and enable the Shopify connection before registering webhooks',
        409,
        'SHOPIFY_WEBHOOK_VERIFICATION_REQUIRED',
      )
    }
    const stored = decryptStoredCredential(runtime)
    if (stored.provider !== 'shopify') throw new Error('Stored commerce credential could not be decrypted')
    const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
    const grant = await requestShopifyAccessToken({
      shopDomain,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
    })
    const providerCredential = { shopDomain, accessToken: grant.accessToken }
    const desiredUri = webhookUrl(runtime.globalId)
    const topics = input.group === 'scope'
      ? SHOPIFY_SCOPE_REFRESH_WEBHOOK_TOPICS
      : input.group === 'inventory'
        ? SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS
        : SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS
    const created = []
    for (const topic of topics) {
      created.push(await createShopifyWebhookSubscription(
        providerCredential,
        { uri: desiredUri, topic },
      ))
    }
    const readiness = await discoverShopifyWebhookSubscriptions(
      providerCredential,
      { desiredUri, topics },
    )
    if (!readiness.ready) {
      throw new CommerceIntegrationRequestError(
        `Shopify ${input.group} webhook registration could not be verified`,
        502,
        'SHOPIFY_WEBHOOK_REGISTRATION_UNVERIFIED',
      )
    }
    await recordCommerceProviderAttemptInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      action: `webhooks.${input.group}.register`,
      adapterVersion: SHOPIFY_ADAPTER_VERSION,
      idempotencyKey,
      requestHash: createHash('sha256').update(JSON.stringify({
        accountGlobalId: runtime.globalId,
        credentialVersion: runtime.credentialVersion,
        desiredUri,
        topics,
      })).digest('hex'),
      redactedRequest: {
        credentialVersion: runtime.credentialVersion,
        topics,
      },
      redactedResponse: {
        ready: true,
        subscriptionCount: readiness.subscriptions.length,
        providerWrites: created.filter((subscription) => subscription.created).length,
      },
      state: 'succeeded',
      providerReference: runtime.externalAccountId,
      errorCode: null,
      actorEmail: input.actorEmail,
      requestedAt: requestedAt.toISOString(),
      completedAt: new Date().toISOString(),
    })
    return testCommerceConnection(input)
  } catch (error) {
    throw sanitize(error)
  }
}

export function registerShopifyScopeWebhookSubscriptions(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  return registerShopifyWebhookSubscriptionGroup({ ...input, group: 'scope' })
}

export function registerShopifyInventoryWebhookSubscriptions(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  return registerShopifyWebhookSubscriptionGroup({ ...input, group: 'inventory' })
}

export function registerShopifyCatalogWebhookSubscriptions(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  return registerShopifyWebhookSubscriptionGroup({ ...input, group: 'catalog' })
}

function orderWebhookResultSnapshot(input: {
  readiness: ShopifyOrderWebhookSubscriptionReadiness
  providerWrites: number | null
  providerReferences: readonly string[]
  recovery: 'provider_dispatch' | 'lost_response_read'
}) {
  return {
    profile: 'seven_topic_minimized_order_signals_v1',
    recovery: input.recovery,
    desiredUri: input.readiness.desiredUri,
    requiredTopics: input.readiness.requiredTopics,
    requiredIncludeFields: input.readiness.requiredIncludeFields,
    observedCount: input.readiness.subscriptions.length,
    matchingCount: input.readiness.matchingTopics.length,
    missingTopics: input.readiness.missingTopics,
    conflictingTopics: input.readiness.conflictingTopics,
    ready: input.readiness.ready,
    providerWrites: input.providerWrites,
    providerReferences: [...input.providerReferences],
    deletionWrites: 0,
  }
}

const SHOPIFY_ORDER_WEBHOOK_AMBIGUOUS_PREFLIGHT_CODES = new Set([
  'SHOPIFY_RATE_LIMITED',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_UNAVAILABLE',
  'SHOPIFY_UPSTREAM_FAILED',
])

function ambiguousShopifyOrderWebhookPreDispatch(error: unknown) {
  return error instanceof ShopifyCommerceClientError
    && (
      error.retryable
      || SHOPIFY_ORDER_WEBHOOK_AMBIGUOUS_PREFLIGHT_CODES.has(error.code)
    )
}

export async function recoverShopifyOrderWebhookCommandKey(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
  confirmation: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const runtime = await storedRuntime(input)
    if (runtime.provider !== 'shopify') {
      throw new CommerceIntegrationRequestError(
        'Order webhook recovery requires a Shopify sales channel',
        400,
        'SHOPIFY_ORDER_WEBHOOK_PROVIDER_REQUIRED',
      )
    }
    if (runtime.status !== 'active' || runtime.verificationStatus !== 'verified') {
      throw new CommerceIntegrationRequestError(
        'Verify and enable the Shopify connection before recovering an open order webhook command',
        409,
        'SHOPIFY_ORDER_WEBHOOK_VERIFICATION_REQUIRED',
      )
    }
    const expectedConfirmation = shopifyOrderWebhookReconciliationConfirmation(
      runtime.globalId,
    )
    if (input.confirmation !== expectedConfirmation) {
      throw new CommerceIntegrationRequestError(
        `Type exactly: ${expectedConfirmation}`,
        400,
        'SHOPIFY_ORDER_WEBHOOK_CONFIRMATION_REQUIRED',
      )
    }
    return readOpenShopifyOrderWebhookRecoveryKeyInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      confirmationHash: createHash('sha256')
        .update(expectedConfirmation)
        .digest('hex'),
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

/**
 * Explicit owner/admin reconciliation of only the seven payload-minimized
 * Shopify order signal subscriptions. The durable command and immutable
 * attempt are committed before the first provider mutation. Ambiguous
 * responses can only be replayed through read-only discovery. A deterministic
 * Shopify user-error boundary may append a residual attempt after discovery.
 */
export async function reconcileShopifyOrderWebhookSetup(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
  idempotencyKey: unknown
  confirmation: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const runtime = await storedRuntime(input)
    if (runtime.provider !== 'shopify') {
      throw new CommerceIntegrationRequestError(
        'Order webhook reconciliation requires a Shopify sales channel',
        400,
        'SHOPIFY_ORDER_WEBHOOK_PROVIDER_REQUIRED',
      )
    }
    if (runtime.status !== 'active' || runtime.verificationStatus !== 'verified') {
      throw new CommerceIntegrationRequestError(
        'Verify and enable the Shopify connection before reconciling order webhooks',
        409,
        'SHOPIFY_ORDER_WEBHOOK_VERIFICATION_REQUIRED',
      )
    }
    const expectedConfirmation = shopifyOrderWebhookReconciliationConfirmation(
      runtime.globalId,
    )
    if (input.confirmation !== expectedConfirmation) {
      throw new CommerceIntegrationRequestError(
        `Type exactly: ${expectedConfirmation}`,
        400,
        'SHOPIFY_ORDER_WEBHOOK_CONFIRMATION_REQUIRED',
      )
    }
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    const desiredUri = webhookUrl(runtime.globalId)
    const requestHash = shopifyOrderWebhookReconciliationRequestHash({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      integrationAccountId: runtime.integrationAccountId,
      credentialGeneration: runtime.credentialVersion,
      externalAccountId: runtime.externalAccountId,
      shopDomain,
      desiredUri,
      actorEmail: input.actorEmail,
    })
    let command = await prepareShopifyOrderWebhookReconciliationInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      integrationAccountId: runtime.integrationAccountId,
      credentialGeneration: runtime.credentialVersion,
      externalAccountId: runtime.externalAccountId,
      shopDomain,
      callbackUri: desiredUri,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      confirmationHash: createHash('sha256')
        .update(expectedConfirmation)
        .digest('hex'),
      actorEmail: input.actorEmail,
    })
    if (command.status === 'succeeded' || command.status === 'reconciled') {
      return readCommerceIntegrationsStateFromPostgres(runtime.organizationId)
    }
    if (command.status === 'failed') {
      throw new CommerceIntegrationRequestError(
        'This exact Shopify order webhook action already failed; inspect its audited outcome before using a new Idempotency-Key',
        409,
        command.errorCode || 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_FAILED',
      )
    }
    if (command.status === 'processing') {
      if (!command.processingLeaseExpired) {
        throw new CommerceIntegrationRequestError(
          'Shopify order webhook reconciliation is already processing',
          409,
          'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_IN_PROGRESS',
        )
      }
      await markStaleShopifyOrderWebhookAttemptUnknownInPostgres({
        organizationId: runtime.organizationId,
        commandId: command.commandId,
        actorEmail: input.actorEmail,
      })
      command = { ...command, status: 'unknown' }
    }
    const recoveryDesiredUri = command.status === 'unknown'
      ? command.callbackUri
      : desiredUri

    const preflight = await (async () => {
      try {
        const stored = decryptStoredCredential(runtime)
        if (stored.provider !== 'shopify') {
          throw new Error('Stored commerce credential could not be decrypted')
        }
        const grant = await requestShopifyAccessToken({
          shopDomain,
          clientId: stored.clientId,
          clientSecret: stored.clientSecret,
        })
        const providerCredential = {
          shopDomain,
          accessToken: grant.accessToken,
        }
        const probe = await probeShopifyConnection(providerCredential)
        if (
          probe.shopId !== runtime.externalAccountId
          || probe.shopDomain !== shopDomain
        ) {
          throw new CommerceIntegrationRequestError(
            'Shopify returned a different verified store identity or canonical domain',
            409,
            'SHOPIFY_ORDER_WEBHOOK_STORE_DRIFT',
          )
        }
        if (
          !grant.grantedScopes.includes('read_orders')
          || !probe.grantedScopes.includes('read_orders')
        ) {
          throw new CommerceIntegrationRequestError(
            'Shopify read_orders access is required for minimized order webhooks',
            409,
            'SHOPIFY_ORDER_WEBHOOK_SCOPE_REQUIRED',
          )
        }
        const readiness = await discoverShopifyOrderWebhookSubscriptions(
          providerCredential,
          { desiredUri: recoveryDesiredUri },
        )
        const recovery = decideShopifyOrderWebhookRecovery(
          command.status === 'recoverable'
            ? 'recoverable'
            : command.status === 'unknown'
              ? 'unknown'
              : 'prepared',
          readiness,
        )
        return { providerCredential, readiness, recovery }
      } catch (error) {
        if (isIntegrationCredentialRuntimeGateError(error)) throw error
        const sanitized = sanitize(error)
        if (
          (command.status === 'prepared' || command.status === 'recoverable')
          && !ambiguousShopifyOrderWebhookPreDispatch(error)
        ) {
          try {
            await failShopifyOrderWebhookPreDispatchInPostgres({
              organizationId: runtime.organizationId,
              commandId: command.commandId,
              actorEmail: input.actorEmail,
              errorCode: sanitized.code,
            })
          } catch {
            // Preserve the exact provider/preflight rejection for the caller.
          }
        }
        throw sanitized
      }
    })()
    const { providerCredential, readiness, recovery } = preflight
    if (recovery.action === 'manual_review') {
      throw new CommerceIntegrationRequestError(
        'The prior Shopify mutation response is ambiguous and read-only discovery is not ready; ClawPilot will issue zero residual provider writes until manual review or exact readiness is observed',
        409,
        'SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN',
      )
    }
    if (
      (command.status === 'unknown' || command.status === 'recoverable')
      && recovery.action === 'reconcile_read_only'
    ) {
      const attemptId = await readShopifyOrderWebhookAttemptIdInPostgres({
        organizationId: runtime.organizationId,
        commandId: command.commandId,
      })
      if (!attemptId) {
        throw new CommerceIntegrationRequestError(
          'The prior Shopify provider attempt could not be reconciled',
          409,
          'SHOPIFY_ORDER_WEBHOOK_ATTEMPT_MISSING',
        )
      }
      await finalizeShopifyOrderWebhookReconciliationInPostgres({
        organizationId: runtime.organizationId,
        commandId: command.commandId,
        attemptId,
        actorEmail: input.actorEmail,
        outcome: 'reconciled',
        providerWriteCount: 0,
        providerReferences: [],
        completedMutations: [],
        stoppedMutation: null,
        stopClassification: null,
        errorCode: null,
        resultSnapshot: orderWebhookResultSnapshot({
          readiness,
          providerWrites: 0,
          providerReferences: readiness.subscriptions.map(
            (subscription) => subscription.providerId,
          ),
          recovery: 'lost_response_read',
        }),
        readiness,
      })
      if (recoveryDesiredUri !== desiredUri) {
        throw new CommerceIntegrationRequestError(
          'The prior ambiguous callback is now reconciled read-only. Confirm again to move the exact subscriptions to the current public callback.',
          409,
          'SHOPIFY_ORDER_WEBHOOK_CALLBACK_DRIFT_RESTART_REQUIRED',
        )
      }
      return readCommerceIntegrationsStateFromPostgres(runtime.organizationId)
    }
    const plan = recovery.plan
    const attempt = await claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: runtime.organizationId,
      commandId: command.commandId,
      actorEmail: input.actorEmail,
      currentCallbackUri: webhookUrl(runtime.globalId),
      mutationPlan: plan,
    })
    assertIntegrationCredentialProviderIoReady()
    const revalidated = await storedRuntime(input)
    if (
      revalidated.organizationId !== runtime.organizationId
      || revalidated.integrationAccountId !== runtime.integrationAccountId
      || revalidated.globalId !== runtime.globalId
      || revalidated.credentialVersion !== runtime.credentialVersion
      || revalidated.externalAccountId !== runtime.externalAccountId
      || normalizeShopifyShopDomain(revalidated.configuration.shopDomain)
        !== shopDomain
      || webhookUrl(revalidated.globalId) !== desiredUri
      || attempt.requestHash !== command.requestHash
    ) {
      await finalizeShopifyOrderWebhookReconciliationInPostgres({
        organizationId: runtime.organizationId,
        commandId: command.commandId,
        attemptId: attempt.attemptId,
        actorEmail: input.actorEmail,
        outcome: 'failed',
        providerWriteCount: 0,
        providerReferences: [],
        completedMutations: [],
        stoppedMutation: null,
        stopClassification: null,
        errorCode: 'SHOPIFY_ORDER_WEBHOOK_BINDING_DRIFT',
        resultSnapshot: {
          profile: 'seven_topic_minimized_order_signals_v1',
          providerWrites: 0,
          deletionWrites: 0,
          failure: 'binding_drift_before_provider',
        },
      })
      throw new CommerceIntegrationRequestError(
        'Shopify account, credential, domain, or callback changed before provider dispatch',
        409,
        'SHOPIFY_ORDER_WEBHOOK_BINDING_DRIFT',
      )
    }

    let result: Awaited<ReturnType<
      typeof reconcileShopifyOrderWebhookSubscriptions
    >>
    try {
      assertIntegrationCredentialProviderIoReady()
      result = await reconcileShopifyOrderWebhookSubscriptions(
        providerCredential,
        {
          desiredUri,
          expectedPlan: plan,
          preparedReadiness: readiness,
        },
      )
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
      const sanitized = sanitize(error)
      const dispatch = error instanceof ShopifyOrderWebhookDispatchError
        ? error
        : null
      const deterministic = dispatch?.stopClassification
        === 'deterministic_rejection'
      const completedMutations = dispatch?.completedMutations || []
      const providerReferences = completedMutations.map(
        (completion) => completion.providerId,
      )
      const outcome = plan.length === 0
        ? 'failed'
        : deterministic
          ? 'recoverable'
          : 'unknown'
      await finalizeShopifyOrderWebhookReconciliationInPostgres({
        organizationId: runtime.organizationId,
        commandId: command.commandId,
        attemptId: attempt.attemptId,
        actorEmail: input.actorEmail,
        outcome,
        providerWriteCount: plan.length === 0
          ? 0
          : deterministic
            ? completedMutations.length
            : null,
        providerReferences,
        completedMutations,
        stoppedMutation: plan.length === 0
          ? null
          : dispatch?.stoppedMutation || null,
        stopClassification: plan.length === 0
          ? null
          : deterministic
            ? 'deterministic_rejection'
            : 'ambiguous',
        errorCode: plan.length === 0
          ? sanitized.code
          : deterministic
            ? sanitized.code
            : 'SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN',
        resultSnapshot: {
          profile: 'seven_topic_minimized_order_signals_v1',
          providerWrites: plan.length === 0
            ? 0
            : deterministic
              ? completedMutations.length
              : null,
          completedMutations,
          stoppedMutation: dispatch?.stoppedMutation || null,
          stopClassification: plan.length === 0
            ? null
            : deterministic
              ? 'deterministic_rejection'
              : 'ambiguous',
          deletionWrites: 0,
          errorCode: sanitized.code,
        },
      })
      if (deterministic) {
        throw new CommerceIntegrationRequestError(
          'Shopify deterministically rejected one order webhook after the recorded completed topics; retry this same Idempotency-Key to discover and dispatch only the residual plan',
          sanitized.status,
          sanitized.code,
        )
      }
      if (plan.length > 0) {
        throw new CommerceIntegrationRequestError(
          'Shopify order webhook dispatch has an ambiguous outcome; retry only this same Idempotency-Key for read-only reconciliation, with zero residual writes until exact readiness is observed',
          409,
          'SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN',
        )
      }
      throw sanitized
    }
    await finalizeShopifyOrderWebhookReconciliationInPostgres({
      organizationId: runtime.organizationId,
      commandId: command.commandId,
      attemptId: attempt.attemptId,
      actorEmail: input.actorEmail,
      outcome: 'succeeded',
      providerWriteCount: result.providerWrites,
      providerReferences: result.providerReferences,
      completedMutations: result.completedMutations,
      stoppedMutation: null,
      stopClassification: null,
      errorCode: null,
      resultSnapshot: orderWebhookResultSnapshot({
        readiness: result.after,
        providerWrites: result.providerWrites,
        providerReferences: result.providerReferences,
        recovery: 'provider_dispatch',
      }),
      readiness: result.after,
    })
    return readCommerceIntegrationsStateFromPostgres(runtime.organizationId)
  } catch (error) {
    throw sanitize(error)
  }
}

export async function setCommerceIntegrationEnabled(input: {
  organizationId: unknown
  accountGlobalId: unknown
  enabled: unknown
  actorEmail: string
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    if (typeof input.enabled !== 'boolean') {
      throw new CommerceIntegrationRequestError(
        'Commerce enabled state must be true or false',
      )
    }
    const runtime = await storedRuntime(input)
    if (input.enabled && runtime.provider === 'faire') {
      throw new CommerceIntegrationRequestError(
        'Faire does not use Shopify signed-receipt intake; its verified provider-read connection remains active independently',
        409,
        'FAIRE_RUNTIME_NOT_IMPLEMENTED',
      )
    }
    if (input.enabled) {
      await testCommerceConnection({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
        actorEmail: input.actorEmail,
      })
      const refreshed = await storedRuntime({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
      })
      const missingReceiptScopes = missingShopifyReceiptProofScopes(
        refreshed.configuration.grantedScopes,
      )
      if (missingReceiptScopes.length) {
        throw new CommerceIntegrationRequestError(
          `Shopify app is missing signed-receipt scopes: ${missingReceiptScopes.join(', ')}`,
          409,
          'SHOPIFY_SCOPE_PROFILE_INCOMPLETE',
        )
      }
      const missingSubscriptionGroups =
        missingShopifyReceiptSubscriptionGroups(refreshed.configuration)
      if (missingSubscriptionGroups.length) {
        throw new CommerceIntegrationRequestError(
          `Shopify signed-receipt subscriptions are not ready: ${missingSubscriptionGroups.join(', ')}`,
          409,
          'SHOPIFY_RECEIPT_SUBSCRIPTIONS_INCOMPLETE',
        )
      }
    }
    const result = await setCommerceIntegrationEnabledInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      enabled: input.enabled,
      actorEmail: input.actorEmail,
    })
    if (!result.updated) {
      throw new CommerceIntegrationRequestError(
        'Verified Shopify app client credentials and one valid signed delivery are required before enabling receipt intake',
        409,
        'COMMERCE_VERIFICATION_REQUIRED',
      )
    }
    return result.state
  } catch (error) {
    throw sanitize(error)
  }
}

export async function setShopifyFulfillmentNotificationPolicy(input: {
  organizationId: unknown
  accountGlobalId: unknown
  expectedRevision: unknown
  notifyCustomerDefault: unknown
  reason: unknown
  confirmCustomerNotifications: unknown
  actorEmail: string
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
    if (
      typeof input.expectedRevision !== 'number'
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0
    ) {
      throw new CommerceIntegrationRequestError(
        'A valid fulfillment notification policy revision is required',
        400,
        'SHOPIFY_FULFILLMENT_NOTIFICATION_REVISION_INVALID',
      )
    }
    if (typeof input.notifyCustomerDefault !== 'boolean') {
      throw new CommerceIntegrationRequestError(
        'Shopify customer notification default must be true or false',
        400,
        'SHOPIFY_FULFILLMENT_NOTIFICATION_DEFAULT_INVALID',
      )
    }
    const reason = String(input.reason || '').trim()
    if (
      reason.length < 10
      || reason.length > 500
      || /[\u0000-\u001f\u007f]/.test(reason)
    ) {
      throw new CommerceIntegrationRequestError(
        'A fulfillment notification policy reason of 10-500 characters is required',
        400,
        'SHOPIFY_FULFILLMENT_NOTIFICATION_REASON_REQUIRED',
      )
    }
    if (
      input.notifyCustomerDefault
      && input.confirmCustomerNotifications !== true
    ) {
      throw new CommerceIntegrationRequestError(
        'Confirm that future Shopify fulfillment confirmations may email customers',
        400,
        'SHOPIFY_FULFILLMENT_NOTIFICATION_CONFIRMATION_REQUIRED',
      )
    }
    await updateShopifyFulfillmentNotificationPolicyInPostgres({
      organizationId,
      accountGlobalId,
      actorEmail: input.actorEmail,
      expectedRevision: input.expectedRevision,
      notifyCustomerDefault: input.notifyCustomerDefault,
      reason,
    })
    return getCommerceIntegrationsState(organizationId)
  } catch (error) {
    throw sanitize(error)
  }
}

export async function disconnectCommerceIntegration(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const runtime = await storedRuntime(input)
    return disconnectCommerceCredentialInPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

function webhookHeader(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum = 255,
) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maximum || !pattern.test(normalized)) {
    throw new CommerceIntegrationRequestError(
      `Shopify ${label} header is invalid`,
      400,
      'SHOPIFY_WEBHOOK_HEADERS_INVALID',
    )
  }
  return normalized
}

export async function receiveShopifyWebhook(input: {
  accountGlobalId: unknown
  rawBody: Buffer
  hmac: unknown
  providerEventId: unknown
  topic: unknown
  sourceDomain: unknown
  providerApiVersion: unknown
  providerTriggeredAt: unknown
}) {
  try {
    assertIntegrationCredentialProviderIoReady()
    const accountGlobalId = normalizeCommerceAccountGlobalId(
      input.accountGlobalId,
    )
    if (
      !Buffer.isBuffer(input.rawBody)
      || input.rawBody.byteLength < 2
      || input.rawBody.byteLength > MAX_WEBHOOK_BYTES
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook payload is invalid or too large',
        413,
        'SHOPIFY_WEBHOOK_TOO_LARGE',
      )
    }
    const runtime = await readCommerceWebhookCredentialFromPostgres(
      accountGlobalId,
    )
    if (
      !runtime
      || !commerceReadCredentialEligible(runtime, {
        developmentRequiresActive: true,
        capability: 'webhook_hydration',
      })
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook destination is unavailable',
        404,
        'SHOPIFY_WEBHOOK_UNAVAILABLE',
      )
    }
    const credential = decryptStoredCredential(runtime)
    if (credential.provider !== 'shopify') {
      throw new Error('Stored commerce credential could not be decrypted')
    }
    if (!verifyShopifyWebhookHmac({
      rawBody: input.rawBody,
      hmac: input.hmac,
      clientSecret: credential.clientSecret,
    })) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook signature is invalid',
        401,
        'SHOPIFY_WEBHOOK_SIGNATURE_INVALID',
      )
    }
    const providerEventId = webhookHeader(
      input.providerEventId,
      'event ID',
      /^[A-Za-z0-9][A-Za-z0-9_-]{7,254}$/,
    )
    const topic = webhookHeader(
      input.topic,
      'topic',
      /^[a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+$/,
    )
    const isOrderSignalTopic = isShopifyOrderSignalWebhookTopic(topic)
    if (
      !SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET.has(topic)
      && !isOrderSignalTopic
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook topic is not accepted by the current control-plane privacy boundary',
        422,
        'SHOPIFY_WEBHOOK_TOPIC_UNSUPPORTED',
      )
    }
    const sourceDomain = normalizeShopifyShopDomain(input.sourceDomain)
    if (sourceDomain !== runtime.configuration.shopDomain) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook store identity does not match the connection',
        401,
        'SHOPIFY_WEBHOOK_STORE_MISMATCH',
      )
    }
    const providerApiVersion = input.providerApiVersion
      ? webhookHeader(
          input.providerApiVersion,
          'API version',
          /^\d{4}-\d{2}$/,
          7,
        )
      : null
    const providerTriggeredAt = input.providerTriggeredAt
      ? new Date(String(input.providerTriggeredAt)).toISOString()
      : null
    if (isOrderSignalTopic) {
      const signal = await recordShopifyOrderWebhookSignalInPostgres({
        runtime,
        providerEventId,
        sourceDomain,
        providerApiVersion,
        providerTriggeredAt,
        expectedCallbackUri: webhookUrl(runtime.globalId),
        evidence: shopifyOrderWebhookSignalEvidence({
          topic,
          verifiedRawBody: input.rawBody,
        }),
      })
      await markShopifyWebhookSecretVerifiedInPostgres({ runtime })
      return signal
    }
    let payload: unknown
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'))
    } catch {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook payload must be valid JSON',
        400,
        'SHOPIFY_WEBHOOK_JSON_INVALID',
      )
    }
    const isInventoryRefreshTopic =
      SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS.some(
        (inventoryTopic) => inventoryTopic === topic,
      )
    if (
      (!payload || typeof payload !== 'object' || Array.isArray(payload))
      && !isInventoryRefreshTopic
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook payload must be a JSON object',
        400,
        'SHOPIFY_WEBHOOK_JSON_INVALID',
      )
    }
    let scopeAudit: ReturnType<
      typeof auditShopifyScopeUpdatePayload
    > | null = null
    if (topic === 'app/scopes_update') {
      try {
        scopeAudit = auditShopifyScopeUpdatePayload(payload)
      } catch {
        throw new CommerceIntegrationRequestError(
          'Shopify scope-update payload is invalid',
          400,
          'SHOPIFY_WEBHOOK_JSON_INVALID',
        )
      }
    }
    const payloadHash = createHash('sha256')
      .update(input.rawBody)
      .digest('hex')
    let productDeletion: ReturnType<
      typeof shopifyDeletedProductEvidence
    > = null
    try {
      productDeletion = shopifyDeletedProductEvidence({
        topic,
        verifiedPayload: payload,
        verifiedPayloadHash: payloadHash,
      })
    } catch {
      throw new CommerceIntegrationRequestError(
        'Shopify product-delete payload is invalid',
        400,
        'SHOPIFY_WEBHOOK_JSON_INVALID',
      )
    }
    let inventoryTargeting: ShopifyInventoryWebhookTargeting | null = null
    if (isInventoryRefreshTopic) {
      inventoryTargeting = shopifyInventoryWebhookTargeting({
        topic,
        verifiedPayload: payload,
        verifiedRawPayload: input.rawBody,
      })
    }
    const encryptedPayload = encryptCommerceWebhookPayload(
      input.rawBody,
      runtime.globalId,
      providerEventId,
      topic,
    )
    const receipt = await recordShopifyWebhookReceiptInPostgres({
      runtime,
      providerEventId,
      topic,
      sourceDomain,
      providerApiVersion,
      payloadHash,
      encryptedPayload,
      payloadBytes: input.rawBody.byteLength,
      providerTriggeredAt,
      scopeAudit,
      productDeletion,
      inventoryTargeting,
    })
    await markShopifyWebhookSecretVerifiedInPostgres({ runtime })
    return receipt
  } catch (error) {
    if (
      error instanceof RangeError
      && String(error.message).toLowerCase().includes('invalid time')
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify triggered-at header is invalid',
        400,
        'SHOPIFY_WEBHOOK_HEADERS_INVALID',
      )
    }
    throw sanitize(error)
  }
}

export function commerceAdapterVersion(provider: CommerceProvider) {
  return provider === 'shopify'
    ? SHOPIFY_ADAPTER_VERSION
    : FAIRE_ADAPTER_VERSION
}
