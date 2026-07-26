import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  SHOPIFY_ADMIN_API_VERSION,
  SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
  SHOPIFY_RECEIPT_PROOF_SCOPES,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  ShopifyCommerceClientError,
  verifyShopifyWebhookHmac,
} from '@/lib/integrations/shopifyCommerceClient'
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
  recordCommerceProviderAttemptInPostgres,
  recordShopifyWebhookReceiptInPostgres,
  setCommerceIntegrationEnabledInPostgres,
  writeCommerceCredentialInPostgres,
  type CommerceRuntimeCredentialRecord,
  type CommerceSyncResource,
} from '@/lib/persistence/commerceIntegrations'
import { appPublicUrl } from '@/lib/publicUrl'

const SHOPIFY_ADAPTER_VERSION = `shopify-graphql-${SHOPIFY_ADMIN_API_VERSION}-control-v1`
const FAIRE_ADAPTER_VERSION = 'faire-external-api-v2-control-v1'
const FAIRE_OAUTH_INSTALLATION_TTL_MS = 15 * 60 * 1000
const MAX_WEBHOOK_BYTES = 512 * 1024
const SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET = new Set<string>(
  SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
)

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
  if (error instanceof CommerceIntegrationRequestError) return error
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
    || normalized.length > 8192
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

function webhookUrl(globalId: string) {
  return new URL(
    `/api/integrations/commerce/shopify/webhooks/${globalId}`,
    appPublicUrl(),
  ).toString()
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
}) {
  try {
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
    const grant = await exchangeFaireOAuthAuthorizationCode({
      applicationId: application.applicationId,
      applicationSecret: application.applicationSecret,
      authorizationCode: input.authorizationCode,
      redirectUrl: pending.redirectUrl,
      scopes: pending.requestedScopes,
      state,
    })
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
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function getCommerceIntegrationsState(
  organizationIdValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const state = await readCommerceIntegrationsStateFromPostgres(organizationId)
  return {
    ...state,
    accounts: state.accounts.map((account) => ({
      ...account,
      webhookUrl: account.provider === 'shopify'
        ? webhookUrl(account.globalId)
        : null,
    })),
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
}) {
  try {
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
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
    const probe = await probeShopifyConnection({
      shopDomain,
      accessToken: grant.accessToken,
    })
    const scopeAudit = auditShopifyScopeRequirements(
      SHOPIFY_RECEIPT_PROOF_SCOPES,
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
      adapterVersion: SHOPIFY_ADAPTER_VERSION,
      apiVersion: probe.apiVersion,
      authMode: credential.authMode,
      grantedScopes: probe.grantedScopes,
      tokenGrantedScopes: grant.grantedScopes,
      tokenAcquisition: 'client_credentials',
      accessTokenLifetimeSeconds: grant.expiresIn,
      accessTokenPersisted: false,
      scopeProfile: 'receipt_evidence_v1',
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
}) {
  try {
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
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
      SHOPIFY_RECEIPT_PROOF_SCOPES,
      probe.grantedScopes,
    )
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
        scopeProfile: 'receipt_evidence_v1',
        requestedScopes: scopeAudit.requestedScopes,
        missingScopes: scopeAudit.missingScopes,
        restrictedScopes: scopeAudit.restrictedScopes,
        lastVerifiedAt: new Date().toISOString(),
        domainWorkersActivated: false,
      },
      providerReference: probe.shopId,
      response: {
        shopId: probe.shopId,
        shopDomain: probe.shopDomain,
        grantedScopeCount: probe.grantedScopes.length,
        tokenLifetimeSeconds: grant.expiresIn,
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
      scopeVerification: 'not_exposed_by_provider',
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
      disableIntegration: runtime.provider === 'shopify'
        && Array.isArray(verified.configuration.missingScopes)
        && verified.configuration.missingScopes.length > 0,
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

export async function setCommerceIntegrationEnabled(input: {
  organizationId: unknown
  accountGlobalId: unknown
  enabled: unknown
  actorEmail: string
}) {
  try {
    if (typeof input.enabled !== 'boolean') {
      throw new CommerceIntegrationRequestError(
        'Commerce enabled state must be true or false',
      )
    }
    const runtime = await storedRuntime(input)
    if (input.enabled && runtime.provider === 'faire') {
      throw new CommerceIntegrationRequestError(
        'Faire runtime polling is not implemented; the verified connection must remain disabled',
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
      const missingScopes = Array.isArray(
        refreshed.configuration.missingScopes,
      )
        ? refreshed.configuration.missingScopes.filter(
          (scope): scope is string => typeof scope === 'string',
        )
        : []
      if (missingScopes.length) {
        throw new CommerceIntegrationRequestError(
          `Shopify app is missing the receipt-proof scopes: ${missingScopes.join(', ')}`,
          409,
          'SHOPIFY_SCOPE_PROFILE_INCOMPLETE',
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

export async function disconnectCommerceIntegration(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: string
}) {
  try {
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
      || runtime.status === 'error'
      || runtime.verificationStatus !== 'verified'
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
    if (!SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET.has(topic)) {
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
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
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
