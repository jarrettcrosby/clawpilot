#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'
import * as globalIds from '../app_src/lib/globalIds.mjs'
import * as commerceOrderRevisionEvidenceKeyConfig from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Object,
    Promise,
    RangeError,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    clearTimeout,
    console,
    crypto,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeHttp'
      ) {
        return {
          integrationCredentialRuntimeMaintenanceResponse() {
            return null
          },
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

const migration = read('db/migrations/0111_operations_commerce_integrations.sql')
const oauthMigration = read('db/migrations/0112_operations_faire_oauth.sql')
const oauthGrantMigration = read(
  'db/migrations/0228_operations_faire_oauth_grant_evidence.sql',
)
includes(migration, [
  "('gcw', 'operations.commerce_webhook_receipt'",
  "('gxa', 'operations.commerce_provider_attempt'",
  'CREATE TABLE IF NOT EXISTS operations_commerce_credentials',
  'external_account_id text NOT NULL',
  'commerce_credential_generation integer',
  "'shopify_client_credentials'",
  'credential_identifier_last_four text NOT NULL',
  'credential_ciphertext bytea NOT NULL',
  'CHECK (octet_length(credential_iv) = 12)',
  'CHECK (octet_length(credential_tag) = 16)',
  'protect_operations_commerce_credential_generation',
  'Commerce credential generations must advance exactly once',
  'CREATE TABLE IF NOT EXISTS operations_commerce_sync_cursors',
  'CREATE TABLE IF NOT EXISTS operations_commerce_webhook_receipts',
  'payload_ciphertext bytea NOT NULL',
  'payload_hash text NOT NULL',
  'max_attempts integer NOT NULL DEFAULT 12',
  'available_at timestamptz NOT NULL DEFAULT now()',
  'operations_commerce_webhook_receipts_delivery_unique',
  'credential_version integer NOT NULL',
  'protect_operations_commerce_webhook_receipt_identity',
  'BEFORE UPDATE OR DELETE ON operations_commerce_webhook_receipts',
  'CREATE TABLE IF NOT EXISTS operations_commerce_provider_attempts',
  "'prepared', 'succeeded', 'failed', 'unknown', 'dead_letter'",
  'attempt_number',
  'idempotency_key',
  'redacted_request jsonb NOT NULL',
  'redacted_response jsonb NOT NULL',
  'protect_operations_commerce_provider_attempt',
  'BEFORE UPDATE OR DELETE ON operations_commerce_provider_attempts',
], 'Commerce migration')
assert.ok(
  !migration.includes('DROP CONSTRAINT IF EXISTS operations_integration_accounts_provider_unique'),
  'Commerce migration must preserve shared carrier/printing account uniqueness',
)
assert.ok(
  !migration.includes('access_token text')
    && !migration.includes('client_secret text')
    && !migration.includes('payload jsonb'),
  'Commerce migration must not persist plaintext credentials or webhook bodies',
)
includes(oauthMigration, [
  "'faire_oauth'",
  'CREATE TABLE IF NOT EXISTS operations_commerce_oauth_installations',
  'browser_session_id uuid NOT NULL',
  'state_hash text NOT NULL UNIQUE',
  "state_hash ~ '^[a-f0-9]{64}$'",
  'application_credential_ciphertext bytea NOT NULL',
  'application_credential_iv bytea NOT NULL',
  'application_credential_tag bytea NOT NULL',
  "expires_at <= created_at + interval '20 minutes'",
  'UNIQUE (organization_id, provider, browser_session_id)',
  'NEW.auth_mode',
  'Commerce authentication mode changes require replacement ciphertext',
  'Commerce credential generations must advance exactly once',
], 'Faire OAuth migration')
assert.ok(
  !oauthMigration.includes('authorization_code text')
    && !oauthMigration.includes('access_token text')
    && !oauthMigration.includes('application_secret text')
    && !oauthMigration.includes('state text NOT NULL'),
  'Faire OAuth migration must not persist raw state, codes, or plaintext secrets',
)
includes(oauthGrantMigration, [
  'operations_faire_oauth_scope_list_valid',
  'operations_faire_oauth_scope_json_valid',
  'validate_operations_faire_scope_evidence_insert',
  'operations_faire_provider_write_scope_evidence_is_current',
  "credential.auth_mode = 'faire_oauth'",
  "attempt.action = 'faire.oauth.authorization_code.exchange'",
  "attempt.state = 'succeeded'",
  "'tokenType', 'BEARER'",
  "'grantType', 'AUTHORIZATION_CODE'",
  "attempt.completed_at - attempt.requested_at <= interval '60 seconds'",
  "attempt.completed_at >= evidence.recorded_at - interval '5 minutes'",
  'auth.verified_write_scopes <@ evidence.verified_write_scopes',
], 'Faire OAuth grant-evidence migration')
assert.ok(
  !/\b(?:access_token|authorization_code|application_secret)\s+(?:text|bytea|jsonb)\b/i
    .test(oauthGrantMigration),
  'Faire OAuth grant evidence must not add plaintext token, code, or secret storage',
)

const persistence = read('app_src/lib/persistence/commerceIntegrations.ts')
includes(persistence, [
  "account.integration_type = 'commerce'",
  'account.organization_id = $1::uuid',
  'operations_commerce_credentials',
  'operations_commerce_sync_cursors',
  'operations_commerce_webhook_receipts',
  'operations_commerce_provider_attempts',
  'acquireTransactionAdvisoryLock',
  'ensureAutomaticCommerceCatalogIntakeWithClient',
  "'commerce.credential.connected'",
  "'commerce.credential.rotated'",
  "'commerce.credential.verified'",
  "'commerce.credential.verification_failed'",
  "'commerce.receipt_intake.queued'",
  "'commerce.receipt_intake.held'",
  "'commerce.shopify.scopes_updated'",
  "'commerce.credential.disconnected'",
  "'commerce.credential.revealed'",
  'productCatalogIntake',
  'COMMERCE_CATALOG_SYNC_CONNECTION_REMOVED',
  "'commerce.webhook.received'",
  "'commerce.inventory.refresh_signaled'",
  'signalShopifyInventoryRefreshWithClient',
  'SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS',
  'webhookQuantityApplied: false',
  "SET state = 'succeeded'",
  'recordCommerceCredentialRevealInPostgres',
  'payload: { credentialVersion: row.credential_version }',
  'holdReceiptIntake?: boolean',
  "reason: 'shopify_receipt_scope_profile_incomplete'",
  'receiptProofScopeIncomplete',
  'payload_hash',
  'Shopify reused a webhook event ID with a different payload',
  'account.commerce_credential_generation = $6',
  'credential.credential_version = $6',
  'row.credential_version !== row.commerce_credential_generation',
  'commerce_credential_generation = $3',
  'credential.credential_version = $3',
  'credential.credential_version =\n                 account.commerce_credential_generation',
  'account.receipt_intake_enabled',
  "'read_products'",
  "'read_inventory'",
  'FOR UPDATE OF account, credential',
  "receiptState: 'queued' | 'held'",
  'Shopify webhook credential generation changed before receipt commit',
  'createFaireOAuthInstallationInPostgres',
  'purgeExpiredFaireOAuthInstallationsInPostgres',
  'discardFaireOAuthInstallationInPostgres',
  'claimFaireOAuthInstallationInPostgres',
  'DELETE FROM operations_commerce_oauth_installations',
  'WHERE expires_at <= now()',
  'AND browser_session_id = $2::uuid',
  'AND actor_email = $3',
  'AND state_hash = $4',
  'AND expires_at > now()',
], 'Commerce persistence')
includes(persistence, [
  'fulfillmentWriteReadiness',
  'operations_faire_fulfillment_scope_evidence_is_current',
  'operations_commerce_active_capability_claim_is_current',
  'scope_evidence_recorded',
], 'Faire fulfillment readiness persistence')
const faireFulfillmentReadiness = read(
  'app_src/lib/integrations/faireFulfillmentReadiness.ts',
)
includes(faireFulfillmentReadiness, [
  'FAIRE_FULFILLMENT_REQUIRED_OAUTH_SCOPES',
  "'READ_BRAND'",
  "'READ_ORDERS'",
  "'READ_SHIPMENTS'",
  "'WRITE_ORDERS'",
  'requested scopes cannot authorize writes',
  'providerWrites: 0',
], 'Faire fulfillment readiness diagnostic')
const commerceEnablePersistence = persistence.slice(
  persistence.indexOf(
    'export async function setCommerceIntegrationEnabledInPostgres',
  ),
  persistence.indexOf(
    'export async function disconnectCommerceCredentialInPostgres',
  ),
)
includes(commerceEnablePersistence, [
  "credential.webhook_verification_status = 'verified'",
  'SET receipt_intake_enabled = $3::boolean',
  "'read_products'",
  "'write_products'",
  "'read_inventory'",
  "'write_inventory'",
  'replayHeldShopifyProductDeletionsInPostgres({',
  'organizationId: input.organizationId',
  'accountGlobalId: input.accountGlobalId',
], 'Shopify receipt-intake readiness')
assert.doesNotMatch(
  commerceEnablePersistence,
  /SET\s+status\s*=/,
  'Shopify receipt-intake policy must not change generic connection status',
)
assert.ok(
  !/console\.(?:log|error|warn)/.test(persistence),
  'Commerce persistence must not log credentials or payloads',
)
const faireOauthDiscardSource = persistence.slice(
  persistence.indexOf(
    'export async function discardFaireOAuthInstallationInPostgres',
  ),
  persistence.indexOf(
    'export async function claimFaireOAuthInstallationInPostgres',
  ),
)
includes(faireOauthDiscardSource, [
  'organization_id = $1::uuid',
  "provider = 'faire'",
  'browser_session_id = $2::uuid',
  'actor_email = $3',
  'state_hash = $4',
  'RETURNING id::text',
], 'Faire OAuth denial cleanup')
const commerceStateReadSource = persistence.slice(
  persistence.indexOf(
    'export async function readCommerceIntegrationsStateFromPostgres',
  ),
  persistence.indexOf(
    'export async function readCommerceRuntimeCredentialFromPostgres',
  ),
)
assert.ok(
  commerceStateReadSource.includes(
    'await purgeExpiredFaireOAuthInstallationsInPostgres()',
  ),
  'Sales-channel reads must purge expired Faire OAuth staging rows',
)
const revealPersistenceSource = persistence.slice(
  persistence.indexOf(
    'export async function recordCommerceCredentialRevealInPostgres',
  ),
  persistence.indexOf('async function auditCommerce'),
)
includes(revealPersistenceSource, [
  'account.organization_id = $1::uuid',
  'account.global_id = $2',
  "account.integration_type = 'commerce'",
  "account.provider IN ('shopify', 'faire')",
  'credential.credential_version =',
  'account.commerce_credential_generation',
  'FOR SHARE OF account, credential',
  "'commerce.credential.revealed'",
], 'Commerce credential reveal persistence')
assert.doesNotMatch(
  revealPersistenceSource,
  /\b(?:credential_ciphertext|credential_iv|credential_tag|clientSecret|applicationSecret|accessToken)\b/,
  'Commerce reveal audit persistence must never select or record secret material',
)

const service = read('app_src/lib/integrations/commerceIntegrations.ts')
includes(service, [
  'await probeShopifyConnection',
  'await probeFaireBrandProfile',
  'startFaireOAuthCommerce',
  'completeFaireOAuthCommerce',
  'purgeExpiredFaireOAuthCommerce',
  'discardFaireOAuthCommerce',
  'requireFaireOAuthHttpsCallback',
  "'FAIRE_OAUTH_PUBLIC_HTTPS_REQUIRED'",
  'randomBytes(32)',
  "toString('base64url')",
  "createHash('sha256').update(state).digest('hex')",
  'encryptFaireOAuthPendingCredential',
  'claimFaireOAuthInstallationInPostgres',
  'exchangeFaireOAuthAuthorizationCode',
  "authMode: 'faire_oauth'",
  "tokenAcquisition: 'authorization_code'",
  'encryptCommerceCredential',
  'domainWorkersActivated: false',
  "'faire_brand_token'",
  "'shopify_client_credentials'",
  'await requestShopifyAccessToken',
  'SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES',
  'SHOPIFY_RECEIPT_PROOF_SCOPES',
  'auditShopifyScopeRequirements',
  'auditShopifyScopeUpdatePayload',
  "scopeProfile: 'distributed_operations_v1'",
  'SHOPIFY_SCOPE_PROFILE_INCOMPLETE',
  'SHOPIFY_CANONICAL_DOMAIN_REQUIRED',
  'missingShopifyReceiptProofScopes',
  "runtime.status === 'error'",
  'verifyShopifyWebhookHmac',
  'encryptCommerceWebhookPayload',
  'recordShopifyWebhookReceiptInPostgres',
  'SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET.has(topic)',
  'topics: SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS',
  'created.filter((subscription) => subscription.created).length',
  "topic === 'app/scopes_update'",
  'SHOPIFY_WEBHOOK_TOPIC_UNSUPPORTED',
  'accountGlobalId: runtime.globalId',
  'credentialGeneration: runtime.credentialVersion',
  "discoveryState: 'succeeded'",
  'discoveryErrorCode: null',
  'Faire does not use Shopify signed-receipt intake',
  'revealCommerceCredential',
  'recordCommerceCredentialRevealInPostgres',
  'expiresAt: new Date(revealedAt.getTime() + 30_000).toISOString()',
], 'Commerce service')
const testConnectionSource = service.slice(
  service.indexOf('export async function testCommerceConnection'),
  service.indexOf('export async function setCommerceIntegrationEnabled'),
)
includes(testConnectionSource, [
  'missingShopifyReceiptProofScopes(',
  'verified.configuration.grantedScopes',
], 'Shopify verification receipt-scope isolation')
assert.doesNotMatch(
  testConnectionSource,
  /verified\.configuration\.missingScopes[\s\S]{0,160}\.length/,
  'connection verification must not hold receipts for unrelated missing scopes',
)
const receiptEnableSource = service.slice(
  service.indexOf('export async function setCommerceIntegrationEnabled'),
  service.indexOf('export async function disconnectCommerceIntegration'),
)
includes(receiptEnableSource, [
  'missingShopifyReceiptProofScopes(',
  'refreshed.configuration.grantedScopes',
  'Shopify app is missing signed-receipt scopes:',
], 'Shopify receipt enablement exact-scope gate')
assert.doesNotMatch(
  receiptEnableSource,
  /configuration\.missingScopes/,
  'receipt enablement must not require the broader Distributed Operations profile',
)
const faireOauthStartSource = service.slice(
  service.indexOf('export async function startFaireOAuthCommerce'),
  service.indexOf('export async function purgeExpiredFaireOAuthCommerce'),
)
assert.ok(
  faireOauthStartSource.indexOf('requireFaireOAuthHttpsCallback')
    < faireOauthStartSource.indexOf('encryptFaireOAuthPendingCredential'),
  'Faire OAuth must reject local HTTP before encrypting or persisting credentials',
)
assert.ok(
  faireOauthStartSource.includes(
    'await purgeExpiredFaireOAuthInstallationsInPostgres()',
  ),
  'Faire OAuth start must purge expired staging rows',
)
const shopifyConnectSource = service.slice(
  service.indexOf('export async function connectShopifyCommerce'),
  service.indexOf('export async function connectFaireCommerce'),
)
includes(shopifyConnectSource, [
  'resolveCanonicalShopDomain: true',
  'submittedShopDomain: shopDomain',
  'shopDomainResolvedFromAlias: probe.shopDomain !== shopDomain',
], 'Shopify authenticated alias resolution')
assert.ok(
  shopifyConnectSource.indexOf('await probeShopifyConnection')
    < shopifyConnectSource.indexOf('const encrypted = encryptCommerceCredential'),
  'Shopify must be verified before encrypted credential persistence',
)
const faireOauthCompleteSource = service.slice(
  service.indexOf('export async function completeFaireOAuthCommerce'),
  service.indexOf('export async function getCommerceIntegrationsState'),
)
assert.ok(
  faireOauthCompleteSource.indexOf('await probeFaireBrandProfile')
    < faireOauthCompleteSource.indexOf('encryptCommerceCredential'),
  'Faire OAuth brand identity must be verified before credential persistence',
)
includes(faireOauthCompleteSource, [
  "grantedScopes: [...pending.requestedScopes]",
  "scopeVerification: 'oauth_grant'",
  "oauthGrantTokenType: grant.tokenType",
  ".update(grant.accessToken)",
  'credentialFingerprintSha256',
  'faireOAuthGrant:',
  'requestedAt: exchangeRequestedAt',
  'completedAt: exchangeCompletedAt',
], 'Faire OAuth successful grant persistence')
const credentialWriteSource = persistence.slice(
  persistence.indexOf(
    'export async function writeCommerceCredentialInPostgres',
  ),
  persistence.indexOf(
    'export async function markCommerceCredentialVerificationInPostgres',
  ),
)
includes(credentialWriteSource, [
  'Faire OAuth credential persistence requires exact grant evidence',
  "oauthGrant.tokenType !== 'BEARER'",
  '/^[a-f0-9]{64}$/.test(',
  "'faire.oauth.authorization_code.exchange'",
  "'succeeded', 1",
  'scopeProofAttemptGlobalId',
  'operations_faire_provider_write_scope_evidence',
  'if (verifiedWriteScopes.length > 0)',
  'operations_faire_provider_write_request_hash($6::jsonb)',
  'operations_faire_provider_write_request_hash($8::jsonb)',
], 'Atomic Faire OAuth credential and grant evidence persistence')
assert.doesNotMatch(
  credentialWriteSource,
  /\b(?:authorizationCode|accessToken|applicationSecret)\b/,
  'Faire OAuth grant persistence must receive only redacted grant facts',
)
const verifyStoredConnectionSource = service.slice(
  service.indexOf('async function verifyStoredConnection'),
  service.indexOf('export async function testCommerceConnection'),
)
includes(verifyStoredConnectionSource, [
  'accountGlobalId: runtime.globalId',
  'credentialGeneration: runtime.credentialVersion',
  "credential.authMode === 'faire_oauth'",
  "runtime.configuration.scopeVerification === 'oauth_grant'",
  "? 'oauth_grant'",
  ": 'not_exposed_by_provider'",
  'scopeEvidenceRefreshed: false',
], 'Faire connection-test persisted grant reporting')
const markVerificationSource = persistence.slice(
  persistence.indexOf(
    'export async function markCommerceCredentialVerificationInPostgres',
  ),
  persistence.indexOf(
    'export async function setCommerceIntegrationEnabledInPostgres',
  ),
)
includes(markVerificationSource, [
  'commerceOrderSyncAccountLockKey({',
  'downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient(',
  "'commerce.order_webhook.transport_downgraded'",
  "reason: 'successful_subscription_discovery_not_ready'",
  'providerWrites: 0',
], 'Successful not-ready Shopify order webhook discovery downgrade')
assert.ok(
  markVerificationSource.indexOf('commerceOrderSyncAccountLockKey({')
    < markVerificationSource.indexOf(
      'UPDATE operations_integration_accounts account',
    ),
  'Verification must serialize the account before configuration and policy mutation',
)
const faireApiKeyConnectSource = service.slice(
  service.indexOf('export async function connectFaireCommerce'),
  service.indexOf('function decryptStoredCredential'),
)
assert.ok(
  faireApiKeyConnectSource.indexOf('await probeFaireBrandProfile')
    < faireApiKeyConnectSource.indexOf('encryptCommerceCredential'),
  'Faire generated API key must be verified read-only before encrypted credential persistence',
)
includes(faireApiKeyConnectSource, [
  "authMode: 'faire_brand_token'",
  'accessToken: token',
  'credentialIdentifierLastFour: token.slice(-4)',
  "webhookVerificationStatus: 'not_applicable'",
  'domainWorkersActivated: false',
], 'Faire generated API key connection')
assert.ok(
  !service.includes('console.'),
  'Commerce integration service must not log credentials',
)
const revealServiceSource = service.slice(
  service.indexOf('export async function revealCommerceCredential'),
  service.indexOf('export async function connectShopifyCommerce'),
)
includes(revealServiceSource, [
  "credential.authMode === 'shopify_client_credentials'",
  'clientId: credential.clientId',
  'clientSecret: credential.clientSecret',
  "credential.authMode === 'faire_oauth'",
  'applicationId: credential.applicationId',
  'applicationSecret: credential.applicationSecret',
  "'COMMERCE_CREDENTIAL_REVEAL_UNAVAILABLE'",
  'accountGlobalId: runtime.globalId',
  'credentialVersion: runtime.credentialVersion',
  'recordCommerceCredentialRevealInPostgres',
  'revealedAt: revealedAt.toISOString()',
], 'Commerce credential reveal service')
assert.doesNotMatch(
  revealServiceSource,
  /\baccessToken\s*:/,
  'Commerce reveal response must never include a Faire OAuth or brand access token',
)
assert.ok(
  !revealServiceSource.includes('...credential'),
  'Commerce reveal response must allow-list application credentials',
)

const adminRoute = read(
  'app_src/app/api/integrations/commerce/route.ts',
)
includes(adminRoute, [
  "export const runtime = 'nodejs'",
  '32 * 1024',
  'operationsCapabilities(actor).canManage',
  'operationsCapabilities(actor).canActivate',
  "action === 'connect-shopify'",
  "action === 'connect-faire-api-key'",
  "action === 'start-faire-oauth'",
  "action === 'test-connection'",
  "action === 'set-receipt-intake'",
  "action === 'register-shopify-scope-webhooks'",
  "action === 'set-enabled'",
  "action === 'disconnect'",
  "action === 'reveal-credential'",
  'canRevealCredentials: canRevealCredential(actor)',
  'requireCredentialViewer(actor)',
  "return role === 'owner' || role === 'admin'",
  "'COMMERCE_CREDENTIAL_REVEAL_FORBIDDEN'",
  'revealCommerceCredential',
  'connectFaireCommerce',
  'confirmLiveAccess',
  "'clientId'",
  "'applicationId'",
  "'applicationSecret'",
  "'scopeProfile'",
  'requireRequestSession(req)',
  "'Cache-Control': 'no-store, max-age=0'",
  'domainWorkersActivated: false',
  'readReconciliationWorkersActivated: commerceReadRuntimeAvailable()',
  'canonicalOrderImport: commerceIntakeRuntimeAvailable()',
  'inventoryMutation: false',
  'fulfillmentExport: false',
  'faireBrandApiKey: true',
  'acceptedReceiptTopics: SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS',
  '...COMMERCE_CUSTOM_INTEGRATION_ONBOARDING',
  'callbackUrl: faireOAuthCallbackUrl()',
  'providerScopes: SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES',
  'providerScopes: FAIRE_API_SCOPES',
], 'Commerce admin route')
includes(adminRoute, [
  'async function commerceMutationIntegrations(',
  'const project = createCommerceIntegrationsStateProjector()',
  'return project(await mutation())',
], 'Commerce mutation response projection')
assert.equal(
  (
    adminRoute.match(
      /const integrations = await commerceMutationIntegrations\(/g,
    ) || []
  ).length,
  10,
  'Every commerce mutation that returns integration state must restore computed account fields',
)
const mutationResponseHelper = adminRoute.slice(
  adminRoute.indexOf('async function commerceMutationIntegrations('),
  adminRoute.indexOf('function organizationId('),
)
assert.ok(
  !mutationResponseHelper.includes('getCommerceIntegrationsState'),
  'Committed commerce mutations must not perform a second state read or purge',
)

let inventoryWebhookProviderWrites = 0
let legacyRefreshReads = 0
let projectorCreations = 0
let projectorSetupFails = false
const committedMutationState = {
  organizationId,
  accounts: [{
    globalId: 'gia0000001',
    provider: 'shopify',
    configuration: {
      webhookSubscriptionReadiness: {
        ready: true,
        missingTopics: [],
      },
    },
  }],
  commerceActiveContinuation: null,
}
class MockCommerceIntegrationRequestError extends Error {
  constructor(
    message,
    status = 400,
    code = 'COMMERCE_REQUEST_INVALID',
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}
const routeUnderMutationTest = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/route.ts',
  {
    mocks: {
      '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
        integrationCredentialRuntimeGate,
      'next/server': {
        NextResponse: {
          json(payload, init) {
            return new Response(JSON.stringify(payload), {
              status: init.status,
              headers: {
                ...init.headers,
                'Content-Type': 'application/json',
              },
            })
          },
        },
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError:
          MockCommerceIntegrationRequestError,
        createCommerceIntegrationsStateProjector() {
          projectorCreations += 1
          if (projectorSetupFails) {
            throw new Error('simulated projector setup failure')
          }
          return (state) => ({
            ...state,
            accounts: state.accounts.map((account) => ({
              ...account,
              webhookUrl: account.provider === 'shopify'
                ? `https://clawpilot.example/webhooks/${account.globalId}`
                : null,
            })),
          })
        },
        async getCommerceIntegrationsState() {
          legacyRefreshReads += 1
          throw new Error('simulated post-commit refresh failure')
        },
        async registerShopifyInventoryWebhookSubscriptions() {
          inventoryWebhookProviderWrites += 1
          return committedMutationState
        },
        faireOAuthCallbackUrl() {
          return 'https://clawpilot.example/faire/oauth/callback'
        },
        sanitizedCommerceIntegrationError(error) {
          return {
            message: error instanceof Error ? error.message : 'Unknown error',
            status: error?.status || 503,
            code: error?.code || 'COMMERCE_TEST_FAILURE',
          }
        },
      },
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable() {
          return false
        },
        commerceReadRuntimeAvailable() {
          return false
        },
      },
      '@/lib/integrations/commerceCapabilities': {
        CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION: {},
        CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION: {},
        COMMERCE_CUSTOM_INTEGRATION_ONBOARDING: {
          shopify: {},
          faire: {},
        },
        COMMERCE_CAPABILITY_DEFINITIONS: {},
        FAIRE_CAPABILITY_SCOPES: {},
        FAIRE_PROVIDER_AVAILABLE_CAPABILITIES: [],
        SHOPIFY_ADMIN_API_VERSION: 'test',
        SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES: [],
        SHOPIFY_CAPABILITY_SCOPES: {},
        SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS: [],
        SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES: [],
        SHOPIFY_RESTRICTED_ACCESS_SCOPES: [],
      },
      '@/lib/integrations/faireCommerceClient': {
        FAIRE_API_SCOPES: [],
        FAIRE_COMMERCE_CAPABILITIES: {
          classification: 'test_faire',
        },
      },
      '@/lib/operations/authorization': {
        operationsCapabilities() {
          return { canManage: true, canActivate: true }
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled() {
          return true
        },
      },
      '@/lib/requestUser': {
        async requireRequestUser() {
          return {
            email: 'operator@example.com',
            organizationId,
          }
        },
        async requireRequestSession() {
          return { id: 'session-id' }
        },
      },
      '@/lib/users': {
        effectiveAuthorizationRole() {
          return 'owner'
        },
      },
    },
  },
)
function inventoryWebhookRequest() {
  return new Request('https://clawpilot.example/api/integrations/commerce', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'register-shopify-inventory-webhooks',
      accountGlobalId: 'gia0000001',
      confirmProviderWrites: true,
    }),
  })
}
const committedMutationResponse = await routeUnderMutationTest.PATCH(
  inventoryWebhookRequest(),
)
assert.equal(committedMutationResponse.status, 200)
const committedMutationPayload = await committedMutationResponse.json()
assert.equal(inventoryWebhookProviderWrites, 1)
assert.equal(projectorCreations, 1)
assert.equal(
  legacyRefreshReads,
  0,
  'Successful provider writes must not depend on a fallible second state read',
)
assert.equal(
  committedMutationPayload.integrations.accounts[0].webhookUrl,
  'https://clawpilot.example/webhooks/gia0000001',
)
assert.deepEqual(
  committedMutationPayload.integrations.accounts[0]
    .configuration.webhookSubscriptionReadiness,
  { ready: true, missingTopics: [] },
  'The authoritative mutation readiness must survive view projection',
)

projectorSetupFails = true
const failedProjectorResponse = await routeUnderMutationTest.PATCH(
  inventoryWebhookRequest(),
)
assert.equal(failedProjectorResponse.status, 503)
assert.equal(
  inventoryWebhookProviderWrites,
  1,
  'View-enrichment setup failure must occur before the provider mutation',
)
assert.equal(legacyRefreshReads, 0)
const faireApiKeyRouteSource = adminRoute.slice(
  adminRoute.indexOf("if (action === 'connect-faire-api-key')"),
  adminRoute.indexOf("if (action === 'test-connection')"),
)
includes(faireApiKeyRouteSource, [
  "'accessToken'",
  "'confirmLiveAccess'",
  'body.confirmLiveAccess !== true',
  'one read-only Faire brand-profile request',
  'connectFaireCommerce',
  'accessToken: body.accessToken',
], 'Faire generated API key route')
assert.ok(
  !faireApiKeyRouteSource.includes('applicationSecret')
    && !faireApiKeyRouteSource.includes('authorizationUrl'),
  'Faire generated API key route must remain separate from OAuth credentials',
)
assert.ok(
  !adminRoute.includes("'accessToken',\n        'clientSecret'"),
  'Shopify Admin API must not accept a pasted short-lived access token',
)

const integrationsDoc = read('docs/modules/user-integrations.md')
includes(integrationsDoc, [
  'scripts/establish-ag-alchemy-development.mjs',
  'limited to the frozen, retirement-bound Railway development database',
  'read-only identity/scope GraphQL query',
  'operator-approved read-only set `read_all_orders`',
  '`read_merchant_managed_fulfillment_orders`',
  'Any granted scope beginning `write_` fails closed',
  'additional granted `read_` scopes remain',
  'leaves the target generic-status `active` for verified reads and registered callback computation with pristine cursors and signed receipt intake false',
  'existing default workspace plus non-Shopify shipping, warehouse, printer, and print-agent identities',
  'uses **Generate API key** to obtain the final brand API key',
  '`X-FAIRE-ACCESS-TOKEN`',
  'The command sends no Faire write request',
  'Settings defaults to the single-brand generated-API-key path',
  'explicitly reveal only the current Shopify client ID/client secret or current Faire OAuth Application ID/Secret ID',
  'removed from the page after 30 seconds',
  'Faire generated API keys are non-revealable',
  'never returns Shopify short-lived access tokens, Faire OAuth or brand access tokens',
], 'Commerce credential and development-establishment documentation')

const webhookRoute = read(
  'app_src/app/api/integrations/commerce/shopify/webhooks/[accountGlobalId]/route.ts',
)
includes(webhookRoute, [
  '512 * 1024',
  'req.body.getReader()',
  'reader.cancel()',
  "req.headers.get('x-shopify-hmac-sha256')",
  "req.headers.get('x-shopify-webhook-id')",
  "req.headers.get('x-shopify-topic')",
  "req.headers.get('x-shopify-shop-domain')",
  'SHOPIFY_WEBHOOK_DESTINATION_INVALID',
  'duplicate: result.duplicate',
], 'Shopify webhook route')
assert.ok(
  webhookRoute.indexOf('normalizeCommerceAccountGlobalId')
    < webhookRoute.indexOf('boundedRequestBody(req, maximumBytes)'),
  'Shopify webhook account path must be validated before reading the body',
)

const proxy = read('app_src/proxy.ts')
assert.ok(
  proxy.includes(
    "normalizedPath.startsWith('/api/integrations/commerce/shopify/webhooks/')",
  ),
  'Only the signed Shopify webhook prefix should bypass browser auth',
)
assert.ok(
  proxy.includes(
    "normalizedPath === '/api/integrations/commerce/faire/oauth/callback'",
  ),
  'Only the exact Faire OAuth callback should bypass proxy session attribution',
)

const faireOauthCallback = read(
  'app_src/app/api/integrations/commerce/faire/oauth/callback/route.ts',
)
includes(faireOauthCallback, [
  "export const runtime = 'nodejs'",
  'requireRequestSession(req)',
  'requireRequestUser(req)',
  'operationsCapabilities(actor).canManage',
  "req.nextUrl.searchParams.get('state')",
  'readFaireOAuthCallbackAuthorizationCode(',
  "req.nextUrl.searchParams.has('error')",
  'completeFaireOAuthCommerce',
  'purgeExpiredFaireOAuthCommerce',
  'discardFaireOAuthCommerce',
  "'Cache-Control': 'no-store, max-age=0'",
  "'Referrer-Policy': 'no-referrer'",
  "url.searchParams.set('settings', 'integrations')",
  "url.searchParams.set('integration', 'commerce')",
], 'Faire OAuth callback')
assert.ok(
  !faireOauthCallback.includes('error_description')
    && !faireOauthCallback.includes("searchParams.set('authorizationCode'"),
  'Faire OAuth callback must not echo provider errors or codes into redirects',
)
assert.ok(
  faireOauthCallback.includes(
    'if (state) {\n        await discardFaireOAuthCommerce',
  ),
  'Faire denial cleanup must require the returned state before deleting',
)

const faireOauthCallbackParser = loadTypeScriptModule(
  'app_src/lib/integrations/faireOAuthCallback.ts',
)
for (const parameterName of [
  'authorizationCode',
  'authorization_code',
  'code',
]) {
  const params = new URLSearchParams({
    [parameterName]: 'faire-authorization-code-1234567890',
  })
  assert.equal(
    faireOauthCallbackParser.readFaireOAuthCallbackAuthorizationCode(params),
    'faire-authorization-code-1234567890',
    `Faire OAuth callback accepts ${parameterName}`,
  )
}
const repeatedFaireCode = new URLSearchParams()
repeatedFaireCode.append('authorizationCode', 'same-faire-code')
repeatedFaireCode.append('code', 'same-faire-code')
assert.equal(
  faireOauthCallbackParser.readFaireOAuthCallbackAuthorizationCode(
    repeatedFaireCode,
  ),
  'same-faire-code',
  'Equivalent Faire OAuth callback aliases remain deterministic',
)
const conflictingFaireCode = new URLSearchParams()
conflictingFaireCode.append('authorizationCode', 'first-faire-code')
conflictingFaireCode.append('code', 'second-faire-code')
assert.equal(
  faireOauthCallbackParser.readFaireOAuthCallbackAuthorizationCode(
    conflictingFaireCode,
  ),
  null,
  'Conflicting Faire OAuth callback aliases fail closed',
)
assert.equal(
  faireOauthCallbackParser.readFaireOAuthCallbackAuthorizationCode(
    new URLSearchParams(),
  ),
  null,
  'Missing Faire OAuth callback code fails closed',
)

const panel = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
includes(panel, [
  'Math.min(',
  '30_000,',
  'Date.parse(revealedCredential.expiresAt) - Date.now()',
  "window.addEventListener('blur', clearRevealedCredential)",
  "window.addEventListener('pagehide', clearRevealedCredential)",
  "document.addEventListener('visibilitychange', clearWhenHidden)",
  'operating-system clipboard',
  'automatically clear',
], 'Commerce credential reveal browser lifetime cap')
includes(panel, [
  'Sales channels',
  'separate from restaurant POS',
  'These are user-owned custom integrations',
  'Before you connect',
  'Connect Shopify Dev Dashboard app',
  'Faire custom integration',
  'Generated API key — single brand (recommended)',
  'Faire generated API key',
  'Connect generated API key',
  "action: 'connect-faire-api-key'",
  'One read-only brand-profile request',
  'The verification call writes no Faire data; after connection, eligible product-only catalog sync may read automatically.',
  'Faire Application ID',
  'Faire Secret ID',
  'Custom App OAuth — if enabled by Faire',
  'Generate a single-brand API key',
  'the Application ID or APA application token is not the API key',
  'ClawPilot OAuth callback URL',
  'Continue to Faire',
  'Connection test — READ_BRAND only',
  'Distributed operations — all 10 documented permissions',
  "authorizationUrl.origin !== 'https://faire.com'",
  "window.location.assign(authorizationUrl.toString())",
  'FAIRE_OAUTH_STATE_INVALID',
  'FAIRE_OAUTH_PUBLIC_HTTPS_REQUIRED',
  'SHOPIFY_SHOP_NOT_PERMITTED',
  'SHOPIFY_STORE_NOT_FOUND',
  'catalog.onboarding.faire.supportContact',
  'const actionError = actionableCommerceError(requestError)',
  'await requestCommerce()',
  'Revoke or remove provider-side access separately',
  'Open setup checklist',
  'Provider scopes and permissions',
  'setupChecklistSteps.map',
  'defaultExpanded={false}',
  'Shopify dashboard',
  'API key guide',
  'Faire generated API-key setup',
  'Faire Custom App OAuth setup',
  'resolveCommerceSetupPermissionGuidance',
  'setupPermissionGuidance.copyable',
  'setupPermissionGuidance.scopes',
  'copyPlainTextToClipboard',
  "setupPermissionGuidance.scopes.join(',')",
  'Comma-separated scope list',
  'press Command+C to copy it',
  'Separate restricted-scope approval · <code>read_all_orders</code>',
  'Protected customer-data approval · <code>read_customers</code>',
  'Shopify read-all-orders approval',
  'Shopify protected-data requirements',
  'OAuth permission list',
  'Not applicable · access is issued with the generated key',
  'Exact OAuth permissions',
  'Open setup checklist',
  'setupChecklistProvider',
  'catalog?.providers.shopify.providerScopes',
  'Signed receipt setup',
  'Register scope safety webhook',
  'Current Shopify webhook receipts need attention',
  'Test connection',
  'refreshes the 24-hour',
  'older exact discovery',
  'does not block a valid signed order event',
  'Copy URL',
  'Distributed Operations scope profile',
  "action: 'set-receipt-intake'",
  'Queue signed receipts',
  'Hold signed receipts',
  'Queued for intake',
  'Held as evidence',
  'synchronization with no second approval',
  'type="password"',
  'confirmLiveAccess',
  'Canonical order import',
  'Provider availability is shown separately',
  'Order-domain workers',
  'Core order topics use a separate payload-free exact-read lane',
  'Customer-bearing topics remain rejected',
  "clientId: ''",
  "applicationId: ''",
  "applicationSecret: ''",
  "apiKey: ''",
  "clientSecret: ''",
  "account.authMode !== 'faire_brand_token'",
  'Faire generated API keys are encrypted and',
  'inputProps={{ maxLength: 4096 }}',
  'Faire fulfillment writes',
  "account.provider === 'shopify' ? (",
  "account.provider === 'faire' && fulfillmentReadiness",
  'Shopify manages customer notifications for this connection',
  'Required OAuth scopes:',
  'diagnostic provider writes: 0',
  'useRef(integrations.organizationId)',
  'payload.integrations.organizationId',
  '!== organizationIdRef.current',
  'const revealOrganizationId = organizationIdRef.current',
  'organizationIdRef.current === revealOrganizationId',
], 'Commerce settings UI')
const browserClipboard = loadTypeScriptModule(
  'app_src/lib/browserClipboard.ts',
  {
    globals: {
      navigator: {
        clipboard: {
          async writeText(value) {
            assert.equal(value, 'read_products,read_orders')
          },
        },
      },
    },
  },
)
assert.equal(
  await browserClipboard.copyPlainTextToClipboard(
    'read_products,read_orders',
  ),
  true,
  'The modern clipboard path must copy the exact comma-separated scope list',
)
let fallbackValue = ''
const fallbackTextarea = {
  value: '',
  style: {},
  setAttribute() {},
  focus() {},
  select() {},
  setSelectionRange() {},
  remove() {},
}
const fallbackClipboard = loadTypeScriptModule(
  'app_src/lib/browserClipboard.ts',
  {
    globals: {
      navigator: {
        clipboard: {
          async writeText() {
            throw new Error('clipboard permission denied')
          },
        },
      },
      document: {
        body: { appendChild() {} },
        createElement() { return fallbackTextarea },
        execCommand(command) {
          assert.equal(command, 'copy')
          fallbackValue = fallbackTextarea.value
          return true
        },
      },
    },
  },
)
assert.equal(
  await fallbackClipboard.copyPlainTextToClipboard(
    'read_products,read_orders',
  ),
  true,
  'A browser that blocks the modern clipboard API must use the selection fallback',
)
assert.equal(fallbackValue, 'read_products,read_orders')
const setupGuidance = read(
  'app_src/lib/integrations/commerceSetupGuidance.ts',
)
includes(setupGuidance, [
  'Exact Shopify app scopes ClawPilot expects',
  "mode: 'provider_issued_access'",
  'There is no OAuth scope list to copy or configure for this path',
  'input.faireScopeProfiles[input.faireScopeProfile]',
  "mode: 'faire_oauth_scopes'",
], 'Commerce setup permission guidance')
const revealPanelSource = panel.slice(
  panel.indexOf('async function revealCredential'),
  panel.indexOf('async function copyRevealedCredential'),
)
assert.ok(
  revealPanelSource.indexOf('setRevealedCredential(null)')
    < revealPanelSource.indexOf('window.confirm'),
  'Starting another credential reveal must clear the prior plaintext first',
)
const applyPayloadSource = panel.slice(
  panel.indexOf('function applyPayload'),
  panel.indexOf('useEffect(() =>'),
)
assert.ok(
  applyPayloadSource.indexOf('setRevealedCredential(null)')
    < applyPayloadSource.indexOf('setIntegrations(payload.integrations)'),
  'A workspace change must clear plaintext before applying the next organization',
)
const integrationSettings = read(
  'app_src/components/settings/IntegrationSettingsPanel.tsx',
)
includes(integrationSettings, [
  "initialIntegration?: 'commerce'",
  "initialIntegration === 'commerce' && canManageOperationsIntegrations",
  "key: 'commerce'",
  "label: 'Sales channels'",
  '<CommerceIntegrationPanel onNavigate={onNavigate} />',
  'canManageOperationsIntegrations',
], 'Integration settings navigation')
const appHeader = read('app_src/components/AppHeader.tsx')
includes(appHeader, [
  "params.get('settings') === 'integrations'",
  "params.get('integration') === 'commerce'",
  'setSettingsInitialTab(3)',
  'setUserAccessOpen(true)',
  'initialTab={settingsInitialTab}',
], 'Commerce OAuth settings deep link')
const userAccessDialog = read(
  'app_src/components/settings/UserAccessDialog.tsx',
)
includes(userAccessDialog, [
  'initialTab = 0',
  'setActiveTab(initialTab)',
  "initialIntegration={initialTab === 3 ? 'commerce' : undefined}",
], 'Commerce OAuth integration deep link')

const capabilities = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCapabilities.ts',
)
assert.equal(capabilities.SHOPIFY_ADMIN_API_VERSION, '2026-07')
assert.deepEqual(
  JSON.parse(JSON.stringify(capabilities.SHOPIFY_RECEIPT_PROOF_SCOPES)),
  ['read_products', 'read_inventory'],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
  )),
  [
    'read_all_orders',
    'write_app_proxy',
    'write_assigned_fulfillment_orders',
    'write_custom_fulfillment_services',
    'read_customers',
    'write_customers',
    'write_inventory',
    'read_locations',
    'read_markets',
    'write_merchant_managed_fulfillment_orders',
    'write_order_edits',
    'read_orders',
    'write_orders',
    'write_products',
    'write_publications',
    'read_returns',
    'write_returns',
    'write_shipping',
    'write_third_party_fulfillment_orders',
  ],
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.shopify.developerPortalUrl,
  'https://dev.shopify.com/dashboard',
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.shopify
    .restrictedOrderScopeApprovalUrl,
  'https://shopify.dev/docs/api/usage/access-scopes#orders-permissions',
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.shopify
    .protectedCustomerDataApprovalUrl,
  'https://shopify.dev/docs/apps/launch/protected-customer-data',
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.faire.setupGuideUrl,
  'https://developers.faire.com/docs#/#authentication',
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.faire.authMode,
  'faire_brand_token',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
      .faire.supportedAuthModes,
  )),
  ['faire_brand_token', 'faire_oauth'],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
      .faire.scopeProfiles.connection_test,
  )),
  ['READ_BRAND'],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
      .faire.brandApiKeyRequiredBeforeConnect,
  )),
  [
    'Create a Faire Developer account and a Custom App.',
    'In Faire Brand Portal, open the unpublished integration for that app and choose Generate API key.',
    'Copy the final provider-issued API key once; do not use the Application ID, APA application token, or Secret ID.',
    'Return to ClawPilot and authorize one read-only brand-profile verification request.',
  ],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
      .faire.oauthRequiredBeforeConnect,
  )),
  [
    'Create a Faire Developer account and a Custom App.',
    'Confirm Faire accepts the Custom App OAuth authorization path for the intended brand.',
    'Copy the Application ID and Secret ID from App Details and Settings.',
    'Select the least-privilege permission profile in ClawPilot, then continue to Faire for approval.',
  ],
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
    .faire.scopeProfiles.distributed_operations.length,
  10,
)
assert.ok(
  capabilities.SHOPIFY_ACCESS_SCOPES.includes(
    'read_inventory_shipments_received_items',
  )
  && capabilities.SHOPIFY_ACCESS_SCOPES.includes(
    'write_inventory_shipments_received_items',
  ),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
  )),
  [
    'app/scopes_update',
    'inventory_items/create',
    'inventory_items/delete',
    'inventory_items/update',
    'inventory_levels/connect',
    'inventory_levels/disconnect',
    'inventory_levels/update',
    'products/create',
    'products/delete',
    'products/update',
  ],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(capabilities.auditShopifyScopeRequirements(
    ['read_products', 'read_inventory'],
    ['write_products', 'write_inventory'],
  ))),
  {
    requestedScopes: ['read_inventory', 'read_products'],
    grantedScopes: ['write_inventory', 'write_products'],
    missingScopes: [],
    restrictedScopes: [],
  },
  'Shopify write scopes must satisfy their paired read requirements',
)
assert.equal(
  capabilities.hasEffectiveShopifyScope(
    ['write_products'],
    'read_products',
  ),
  true,
  'Shopify capability checks must honor write scope implied read access',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(capabilities.auditShopifyScopeUpdatePayload({
    current: capabilities.SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES.filter(
      (scope) => scope !== 'write_inventory',
    ),
    previous: capabilities.SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
  }))),
  {
    requestedScopes: [
      'read_all_orders',
      'read_customers',
      'read_locations',
      'read_markets',
      'read_orders',
      'read_returns',
      'write_app_proxy',
      'write_assigned_fulfillment_orders',
      'write_custom_fulfillment_services',
      'write_customers',
      'write_inventory',
      'write_merchant_managed_fulfillment_orders',
      'write_order_edits',
      'write_orders',
      'write_products',
      'write_publications',
      'write_returns',
      'write_shipping',
      'write_third_party_fulfillment_orders',
    ],
    grantedScopes: [
      'read_all_orders',
      'read_customers',
      'read_locations',
      'read_markets',
      'read_orders',
      'read_returns',
      'write_app_proxy',
      'write_assigned_fulfillment_orders',
      'write_custom_fulfillment_services',
      'write_customers',
      'write_merchant_managed_fulfillment_orders',
      'write_order_edits',
      'write_orders',
      'write_products',
      'write_publications',
      'write_returns',
      'write_shipping',
      'write_third_party_fulfillment_orders',
    ],
    missingScopes: ['write_inventory'],
    restrictedScopes: ['read_all_orders'],
  },
  'Shopify scope-update events must expose a fail-closed Operations-profile audit',
)
assert.throws(
  () => capabilities.auditShopifyScopeUpdatePayload({
    current: 'read_products',
  }),
  /scope-update payload was invalid/,
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.order_import,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.webhook_verification,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION
    .product_synchronization,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION
    .shipping_rate_callbacks,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.fulfillment_export,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.tracking_export,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.order_import,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION
    .product_synchronization,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.oauth_authentication,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.order_update,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.fulfillment_export,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.tracking_export,
  'control_plane_implemented',
)
for (const capability of [
  'order_update',
  'fulfillment_export',
  'tracking_export',
]) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      capabilities.FAIRE_CAPABILITY_SCOPES[capability],
    )),
    ['READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'],
  )
}
assert.ok(
  capabilities.SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES.includes('order_import'),
)
assert.ok(
  !capabilities.FAIRE_PROVIDER_AVAILABLE_CAPABILITIES.includes(
    'webhook_registration',
  ),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(capabilities.auditShopifyScopes(
    ['order_import', 'fulfillment_export', 'retry'],
    ['read_orders'],
  ))),
  {
    requestedScopes: [
      'read_orders',
      'write_merchant_managed_fulfillment_orders',
    ],
    grantedScopes: ['read_orders'],
    missingScopes: ['write_merchant_managed_fulfillment_orders'],
    restrictedScopes: [],
  },
)

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
  'commerce-test-encryption-key-0123456789abcdef'
const cryptoModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  {
    mocks: {
      '@/lib/globalIds.mjs': globalIds,
      '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
        integrationCredentialRuntimeGate,
      '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs':
        commerceOrderRevisionEvidenceKeyConfig,
      '@/lib/persistence/config': { isHostedRuntime: () => false },
    },
  },
)
const credential = {
  provider: 'shopify',
  authMode: 'shopify_client_credentials',
  clientId: 'shopify-client-id-1234567890',
  clientSecret: 'shopify-client-secret-1234567890',
}
const externalAccountId = 'gid://shopify/Shop/123456789'
const encrypted = cryptoModule.encryptCommerceCredential(
  credential,
  organizationId,
  'sandbox',
  externalAccountId,
)
assert.equal(encrypted.iv.length, 12)
assert.equal(encrypted.tag.length, 16)
assert.ok(
  !encrypted.ciphertext.includes(Buffer.from(credential.clientSecret)),
  'Commerce ciphertext must not contain the Shopify client secret',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(cryptoModule.decryptCommerceCredential(
    encrypted,
    organizationId,
    'shopify',
    'sandbox',
    externalAccountId,
  ))),
  credential,
)
for (const [org, provider, environment, account] of [
  [otherOrganizationId, 'shopify', 'sandbox', externalAccountId],
  [organizationId, 'faire', 'production', externalAccountId],
  [organizationId, 'shopify', 'production', externalAccountId],
  [organizationId, 'shopify', 'sandbox', 'gid://shopify/Shop/999999999'],
]) {
  assert.throws(
    () => cryptoModule.decryptCommerceCredential(
      encrypted,
      org,
      provider,
      environment,
      account,
    ),
    /could not be decrypted/,
    'Credential AAD must reject a changed tenant/provider/environment/account',
  )
}
assert.throws(
  () => cryptoModule.normalizeCommerceEnvironment('sandbox', 'faire'),
  /does not provide a public sandbox/,
)
const faireOAuthCredential = {
  provider: 'faire',
  authMode: 'faire_oauth',
  applicationId: 'faire-test-application-id',
  applicationSecret: 'faire-secret-id-1234567890',
  accessToken: 'faire-oauth-access-token-1234567890',
  scopes: ['READ_BRAND'],
}
assert.equal(
  cryptoModule.normalizeFaireApplicationId(faireOAuthCredential.applicationId),
  faireOAuthCredential.applicationId,
  'Faire application IDs must not be constrained to an undocumented prefix',
)
const encryptedFaireOAuth = cryptoModule.encryptCommerceCredential(
  faireOAuthCredential,
  organizationId,
  'production',
  'brand_123',
)
assert.ok(
  !encryptedFaireOAuth.ciphertext.includes(
    Buffer.from(faireOAuthCredential.applicationSecret),
  )
    && !encryptedFaireOAuth.ciphertext.includes(
      Buffer.from(faireOAuthCredential.accessToken),
    ),
  'Faire OAuth ciphertext must not expose the app secret or access token',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(cryptoModule.decryptCommerceCredential(
    encryptedFaireOAuth,
    organizationId,
    'faire',
    'production',
    'brand_123',
  ))),
  faireOAuthCredential,
)
const browserSessionId = '33333333-3333-4333-8333-333333333333'
const stateHash = crypto.createHash('sha256')
  .update('oauth-state-12345678901234567890123456789012')
  .digest('hex')
const encryptedPendingFaire = cryptoModule.encryptFaireOAuthPendingCredential(
  {
    applicationId: faireOAuthCredential.applicationId,
    applicationSecret: faireOAuthCredential.applicationSecret,
  },
  organizationId,
  browserSessionId,
  stateHash,
)
assert.ok(
  !encryptedPendingFaire.ciphertext.includes(
    Buffer.from(faireOAuthCredential.applicationSecret),
  ),
  'Pending Faire OAuth state must encrypt the Secret ID',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    cryptoModule.decryptFaireOAuthPendingCredential(
      encryptedPendingFaire,
      organizationId,
      browserSessionId,
      stateHash,
    ),
  )),
  {
    applicationId: faireOAuthCredential.applicationId,
    applicationSecret: faireOAuthCredential.applicationSecret,
  },
)
for (const [org, session, digest] of [
  [otherOrganizationId, browserSessionId, stateHash],
  [organizationId, '44444444-4444-4444-8444-444444444444', stateHash],
  [organizationId, browserSessionId, 'a'.repeat(64)],
]) {
  assert.throws(
    () => cryptoModule.decryptFaireOAuthPendingCredential(
      encryptedPendingFaire,
      org,
      session,
      digest,
    ),
    /could not be decrypted/,
    'Pending Faire OAuth credential AAD must bind tenant, session, and state',
  )
}

const rawWebhook = Buffer.from('{"id":123,"name":"#1001"}')
const encryptedWebhook = cryptoModule.encryptCommerceWebhookPayload(
  rawWebhook,
  'gia1234567',
  'event-12345678',
  'orders/create',
)
assert.deepEqual(
  cryptoModule.decryptCommerceWebhookPayload(
    encryptedWebhook,
    'gia1234567',
    'event-12345678',
    'orders/create',
  ),
  rawWebhook,
)
assert.throws(
  () => cryptoModule.decryptCommerceWebhookPayload(
    encryptedWebhook,
    'gia1234567',
    'event-87654321',
    'orders/create',
  ),
  /could not be decrypted/,
)

const shopifyClient = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyCommerceClient.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCapabilities': capabilities,
      '@/lib/integrations/shopifyCarrierServiceBranding': {
        normalizeShopifyStoreEntityName(value) {
          if (typeof value !== 'string') throw new Error('invalid')
          const normalized = value
            .normalize('NFKC')
            .replace(/\s+/g, ' ')
            .trim()
          if (
            normalized.length < 1
            || [...normalized].length > 255
            || /[\u0000-\u001f\u007f]/.test(normalized)
          ) {
            throw new Error('invalid')
          }
          return normalized
        },
      },
    },
  },
)
assert.equal(
  shopifyClient.normalizeShopifyShopDomain(
    '  Example-Store.myshopify.com  ',
  ),
  'example-store.myshopify.com',
)
assert.throws(
  () => shopifyClient.normalizeShopifyShopDomain(
    'https://example-store.myshopify.com/admin',
  ),
  (error) => error.code === 'SHOPIFY_DOMAIN_INVALID',
)
const hmac = crypto
  .createHmac('sha256', credential.clientSecret)
  .update(rawWebhook)
  .digest('base64')
assert.equal(shopifyClient.verifyShopifyWebhookHmac({
  rawBody: rawWebhook,
  hmac,
  clientSecret: credential.clientSecret,
}), true)
assert.equal(shopifyClient.verifyShopifyWebhookHmac({
  rawBody: Buffer.from('{"id":124}'),
  hmac,
  clientSecret: credential.clientSecret,
}), false)

const issuedAccessToken = 'shopify-issued-access-token-1234567890'
const tokenRequests = []
const tokenGrant = await shopifyClient.requestShopifyAccessToken(
  {
    shopDomain: 'example-store.myshopify.com',
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  },
  {
    fetchImpl: async (url, init) => {
      tokenRequests.push({ url, init })
      return new Response(JSON.stringify({
        access_token: issuedAccessToken,
        scope: 'read_products,read_orders',
        expires_in: 86399,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  },
)
assert.equal(tokenGrant.accessToken, issuedAccessToken)
assert.equal(tokenGrant.expiresIn, 86399)
assert.deepEqual(
  JSON.parse(JSON.stringify(tokenGrant.grantedScopes)),
  ['read_orders', 'read_products'],
)
assert.equal(
  String(tokenRequests[0].url),
  'https://example-store.myshopify.com/admin/oauth/access_token',
)
assert.equal(
  tokenRequests[0].init.headers['Content-Type'],
  'application/x-www-form-urlencoded',
)
assert.equal(
  tokenRequests[0].init.body.get('grant_type'),
  'client_credentials',
)
assert.equal(tokenRequests[0].init.body.get('client_id'), credential.clientId)
assert.equal(
  tokenRequests[0].init.body.get('client_secret'),
  credential.clientSecret,
)
await assert.rejects(
  shopifyClient.requestShopifyAccessToken(
    {
      shopDomain: 'example-store.myshopify.com',
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    },
    {
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'shop_not_permitted',
        error_description:
          'Client credentials cannot be performed on this shop.',
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    },
  ),
  (error) => error?.code === 'SHOPIFY_SHOP_NOT_PERMITTED'
    && /same Dev Dashboard organization/.test(error.message),
)
await assert.rejects(
  shopifyClient.requestShopifyAccessToken(
    {
      shopDomain: 'missing-store.myshopify.com',
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    },
    {
      fetchImpl: async () => new Response('', { status: 404 }),
    },
  ),
  (error) => error?.code === 'SHOPIFY_STORE_NOT_FOUND',
)

const shopifyRequests = []
const shopifyProbe = await shopifyClient.probeShopifyConnection(
  {
    shopDomain: 'example-store.myshopify.com',
    accessToken: issuedAccessToken,
  },
  {
    fetchImpl: async (url, init) => {
      shopifyRequests.push({ url, init })
      return new Response(JSON.stringify({
        data: {
          shop: {
            id: externalAccountId,
            myshopifyDomain: 'example-store.myshopify.com',
            name: 'Example Store',
          },
          currentAppInstallation: {
            accessScopes: [
              { handle: 'read_orders' },
              { handle: 'read_products' },
            ],
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  },
)
assert.equal(shopifyProbe.shopId, externalAccountId)
assert.equal(shopifyProbe.shopName, 'Example Store')
assert.deepEqual(
  JSON.parse(JSON.stringify(shopifyProbe.grantedScopes)),
  ['read_orders', 'read_products'],
)
assert.match(
  String(shopifyRequests[0].url),
  /example-store\.myshopify\.com\/admin\/api\/2026-07\/graphql\.json$/,
)
assert.equal(
  shopifyRequests[0].init.headers['X-Shopify-Access-Token'],
  issuedAccessToken,
)
const canonicalAliasResponse = () => new Response(JSON.stringify({
  data: {
    shop: {
      id: externalAccountId,
      myshopifyDomain: 'canonical-store.myshopify.com',
      name: 'Canonical Store',
    },
    currentAppInstallation: {
      accessScopes: [
        { handle: 'read_orders' },
        { handle: 'read_products' },
      ],
    },
  },
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
await assert.rejects(
  shopifyClient.probeShopifyConnection(
    {
      shopDomain: 'store-alias.myshopify.com',
      accessToken: issuedAccessToken,
    },
    { fetchImpl: async () => canonicalAliasResponse() },
  ),
  (error) => error?.code === 'SHOPIFY_CANONICAL_DOMAIN_REQUIRED',
  'Stored connection checks must continue to fail closed on a domain change.',
)
const canonicalAliasProbe = await shopifyClient.probeShopifyConnection(
  {
    shopDomain: 'store-alias.myshopify.com',
    accessToken: issuedAccessToken,
  },
  {
    fetchImpl: async () => canonicalAliasResponse(),
    resolveCanonicalShopDomain: true,
  },
)
assert.equal(canonicalAliasProbe.shopDomain, 'canonical-store.myshopify.com')
await assert.rejects(
  shopifyClient.probeShopifyConnection(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    {
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          shop: {
            id: externalAccountId,
            myshopifyDomain: 'example-store.myshopify.com',
            name: 'ﬃ'.repeat(86),
          },
          currentAppInstallation: {
            accessScopes: [
              { handle: 'read_orders' },
              { handle: 'read_products' },
            ],
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    },
  ),
  (error) => error?.code === 'SHOPIFY_PROBE_INVALID',
  'Provider identity must be NFKC-normalized before the 255-character bound.',
)

const inventoryWebhookUri =
  'https://clawpilot.example/api/integrations/commerce/shopify/webhooks/gia1234567'
const inventoryWebhookNodes = [
  {
    id: 'gid://shopify/WebhookSubscription/101',
    topic: 'INVENTORY_ITEMS_UPDATE',
    uri: inventoryWebhookUri,
    format: 'JSON',
  },
  {
    id: 'gid://shopify/WebhookSubscription/102',
    topic: 'INVENTORY_LEVELS_UPDATE',
    uri: inventoryWebhookUri,
    format: 'JSON',
  },
]
const inventoryWebhookDiscoveryResponse = (input = {}) => new Response(
  JSON.stringify({
    data: {
      webhookSubscriptions: {
        nodes: input.nodes ?? inventoryWebhookNodes,
        pageInfo: input.pageInfo ?? { hasNextPage: false, endCursor: null },
      },
    },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)
const inventoryWebhookReadiness =
  await shopifyClient.discoverShopifyWebhookSubscriptions(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    {
      desiredUri: inventoryWebhookUri,
      topics: ['inventory_items/update', 'inventory_levels/update'],
    },
    { fetchImpl: async () => inventoryWebhookDiscoveryResponse() },
  )
assert.equal(inventoryWebhookReadiness.ready, true)
assert.equal(inventoryWebhookReadiness.subscriptions.length, 2)
assert.ok(inventoryWebhookReadiness.subscriptions.every(
  (subscription) => subscription.format === 'JSON',
))
await assert.rejects(
  shopifyClient.discoverShopifyWebhookSubscriptions(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    {
      desiredUri: inventoryWebhookUri,
      topics: ['inventory_items/update', 'inventory_levels/update'],
    },
    {
      fetchImpl: async () => inventoryWebhookDiscoveryResponse({
        pageInfo: { hasNextPage: true, endCursor: 'cursor-100' },
      }),
    },
  ),
  (error) => error?.code === 'SHOPIFY_WEBHOOK_SUBSCRIPTION_DISCOVERY_TRUNCATED',
  'Inventory subscription readiness must fail closed beyond the first 100 rows',
)
await assert.rejects(
  shopifyClient.discoverShopifyWebhookSubscriptions(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    {
      desiredUri: inventoryWebhookUri,
      topics: ['inventory_items/update', 'inventory_levels/update'],
    },
    {
      fetchImpl: async () => inventoryWebhookDiscoveryResponse({
        nodes: [{ ...inventoryWebhookNodes[0], format: 'XML' }],
      }),
    },
  ),
  (error) => error?.code === 'SHOPIFY_WEBHOOK_SUBSCRIPTION_RESPONSE_INVALID',
  'Malformed or non-JSON subscription rows must not be silently dropped',
)
const duplicateInventoryWebhookReadiness =
  await shopifyClient.discoverShopifyWebhookSubscriptions(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    {
      desiredUri: inventoryWebhookUri,
      topics: ['inventory_items/update', 'inventory_levels/update'],
    },
    {
      fetchImpl: async () => inventoryWebhookDiscoveryResponse({
        nodes: [
          ...inventoryWebhookNodes,
          { ...inventoryWebhookNodes[0], id: 'gid://shopify/WebhookSubscription/103' },
        ],
      }),
    },
  )
assert.equal(duplicateInventoryWebhookReadiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(duplicateInventoryWebhookReadiness.conflictingTopics)),
  ['inventory_items/update'],
)

const faireClient = loadTypeScriptModule(
  'app_src/lib/integrations/faireCommerceClient.ts',
)
assert.equal(
  faireClient.FAIRE_API_BASE_URL,
  'https://www.faire.com/external-api/v2',
)
assert.equal(
  faireClient.FAIRE_OAUTH_AUTHORIZE_URL,
  'https://faire.com/oauth2/authorize',
)
assert.equal(
  faireClient.FAIRE_OAUTH_TOKEN_URL,
  'https://www.faire.com/api/external-api-oauth2/token',
)
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.webhooks, false)
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.sandbox, false)
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.returnWrites, false)
const faireOauthState = 'faire-oauth-state-123456789012345678901234567890'
const faireOauthRedirect =
  'https://dev.clawpilot.example/api/integrations/commerce/faire/oauth/callback'
const faireAuthorizationUrl = new URL(
  faireClient.buildFaireOAuthAuthorizationUrl({
    applicationId: faireOAuthCredential.applicationId,
    redirectUrl: faireOauthRedirect,
    scopes: ['READ_BRAND', 'READ_ORDERS'],
    state: faireOauthState,
  }),
)
assert.equal(faireAuthorizationUrl.origin, 'https://faire.com')
assert.equal(faireAuthorizationUrl.pathname, '/oauth2/authorize')
assert.equal(
  faireAuthorizationUrl.searchParams.get('applicationId'),
  faireOAuthCredential.applicationId,
)
assert.deepEqual(
  faireAuthorizationUrl.searchParams.getAll('scope'),
  ['READ_BRAND', 'READ_ORDERS'],
)
assert.equal(
  faireAuthorizationUrl.searchParams.get('redirectUrl'),
  faireOauthRedirect,
)
assert.equal(faireAuthorizationUrl.searchParams.get('state'), faireOauthState)

const faireTokenRequests = []
const faireTokenGrant = await faireClient.exchangeFaireOAuthAuthorizationCode(
  {
    applicationId: faireOAuthCredential.applicationId,
    applicationSecret: faireOAuthCredential.applicationSecret,
    authorizationCode: 'faire-authorization-code-1234567890',
    redirectUrl: faireOauthRedirect,
    scopes: ['READ_BRAND'],
    state: faireOauthState,
  },
  {
    fetchImpl: async (url, init) => {
      faireTokenRequests.push({ url: String(url), init })
      return new Response(JSON.stringify({
        access_token: faireOAuthCredential.accessToken,
        token_type: 'BEARER',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(faireTokenGrant)),
  {
    accessToken: faireOAuthCredential.accessToken,
    tokenType: 'BEARER',
  },
)
assert.equal(
  faireTokenRequests[0].url,
  'https://www.faire.com/api/external-api-oauth2/token',
)
assert.equal(faireTokenRequests[0].init.redirect, 'error')
assert.equal(faireTokenRequests[0].init.credentials, 'omit')
assert.deepEqual(
  JSON.parse(faireTokenRequests[0].init.body),
  {
    application_token: faireOAuthCredential.applicationId,
    application_secret: faireOAuthCredential.applicationSecret,
    redirect_url: faireOauthRedirect,
    scope: ['READ_BRAND'],
    grant_type: 'AUTHORIZATION_CODE',
    authorization_code: 'faire-authorization-code-1234567890',
  },
  'Faire token exchange must use the provider-accepted snake_case body',
)
const faireRequests = []
const faireApi = faireClient.createFaireCommerceClient({
  accessToken: 'faire-brand-token-1234567890',
  fetchImpl: async (url, init) => {
    const requestUrl = String(url)
    faireRequests.push({ url: requestUrl, init })
    if (requestUrl.includes('/product-inventory/by-product-variant-ids')) {
      return new Response(JSON.stringify({
        inventories: {
          product_variant_123: {
            on_hand_quantity: { type: 'QUANTITY', quantity: -1 },
            committed_quantity: { type: 'QUANTITY', quantity: 3 },
            available_quantity: { type: 'QUANTITY', quantity: -4 },
          },
        },
      }), { status: 200 })
    }
    if (requestUrl.endsWith('/orders/order_123')) {
      return new Response(JSON.stringify({
        order: {
          id: 'order_123',
          state: 'NEW',
        },
      }), { status: 200 })
    }
    if (requestUrl.includes('/products?')) {
      return new Response(JSON.stringify({
        limit: 50,
        cursor: 'faire-products-next-page',
        products: [{ id: 'product_123' }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      brand_id: 'brand_123',
      name: 'Example Faire Brand',
    }), { status: 200 })
  },
})
const faireProfile = await faireApi.probeBrandProfile()
assert.equal(faireProfile.brand_id, 'brand_123')
assert.equal(
  faireRequests[0].url,
  'https://www.faire.com/external-api/v2/brands/profile',
)
assert.equal(
  faireRequests[0].init.headers.get('X-FAIRE-ACCESS-TOKEN'),
  'faire-brand-token-1234567890',
)
const faireInventory = await faireApi.listInventory({
  productVariantIds: ['product_variant_123', 'product_variant_456'],
})
assert.deepEqual(
  JSON.parse(JSON.stringify(
    faireInventory.inventories.product_variant_123.available_quantity,
  )),
  { type: 'QUANTITY', quantity: -4 },
)
assert.equal(
  faireRequests[1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-product-variant-ids?ids=product_variant_123&ids=product_variant_456',
)
const faireOrder = await faireApi.getOrder('order_123')
assert.equal(faireOrder.id, 'order_123')
assert.equal(
  faireRequests[2].url,
  'https://www.faire.com/external-api/v2/orders/order_123',
)
const faireProducts = await faireApi.listProducts({
  cursor: 'faire-products-current-page',
  limit: 50,
  includeDeleted: true,
})
assert.equal(faireProducts.products.length, 1)
assert.equal(
  faireProducts.cursor,
  'faire-products-next-page',
  'Faire list responses must retain the provider continuation cursor',
)
assert.equal(
  faireRequests[3].url,
  'https://www.faire.com/external-api/v2/products?limit=50&cursor=faire-products-current-page&include_deleted=true',
  'Faire catalog reconciliation must retain the cursor and include deleted listings',
)
await assert.rejects(
  faireApi.listProducts({ includeDeleted: 'yes' }),
  (error) => error.code === 'FAIRE_INCLUDE_DELETED_INVALID',
  'Faire list requests must reject a non-boolean include-deleted selection',
)
await assert.rejects(
  faireApi.listProducts({ cursor: 'x'.repeat(4_097) }),
  (error) => error.code === 'FAIRE_CURSOR_INVALID',
  'Faire list requests must reject oversized continuation cursors',
)
assert.equal('registerWebhook' in faireApi, false)
assert.equal('writeReturn' in faireApi, false)

const invalidCommittedFaireApi = faireClient.createFaireCommerceClient({
  accessToken: 'faire-brand-token-1234567890',
  fetchImpl: async () => new Response(JSON.stringify({
    inventories: {
      product_variant_123: {
        committed_quantity: { type: 'QUANTITY', quantity: -1 },
      },
    },
  }), { status: 200 }),
})
await assert.rejects(
  invalidCommittedFaireApi.listInventory({
    productVariantIds: ['product_variant_123'],
  }),
  (error) => error.code === 'FAIRE_RESPONSE_INVALID',
  'Faire committed inventory must remain nonnegative',
)

const faireOauthRequests = []
const faireOauthApi = faireClient.createFaireCommerceClient({
  accessToken: faireOAuthCredential.accessToken,
  applicationId: faireOAuthCredential.applicationId,
  applicationSecret: faireOAuthCredential.applicationSecret,
  fetchImpl: async (url, init) => {
    faireOauthRequests.push({ url: String(url), init })
    return new Response(JSON.stringify({
      brand_id: 'brand_123',
      name: 'Example Faire Brand',
    }), { status: 200 })
  },
})
await faireOauthApi.probeBrandProfile()
assert.equal(
  faireOauthRequests[0].init.headers.get('X-FAIRE-APP-CREDENTIALS'),
  Buffer.from(
    `${faireOAuthCredential.applicationId}:${faireOAuthCredential.applicationSecret}`,
  ).toString('base64'),
)
assert.equal(
  faireOauthRequests[0].init.headers.get('X-FAIRE-OAUTH-ACCESS-TOKEN'),
  faireOAuthCredential.accessToken,
)
assert.equal(
  faireOauthRequests[0].init.headers.has('X-FAIRE-ACCESS-TOKEN'),
  false,
)

const previewMigration = read(
  'db/migrations/0113_operations_shopify_order_preview.sql',
)
includes(previewMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_order_preview_runs',
  'CREATE TABLE IF NOT EXISTS operations_commerce_order_previews',
  'WHEN jsonb_array_length(value) > 20 THEN false',
  'max_orders integer NOT NULL CHECK (max_orders BETWEEN 1 AND 25)',
  'orders_seen integer NOT NULL CHECK (orders_seen BETWEEN 0 AND 25)',
  'canonical_orders_created integer NOT NULL DEFAULT 0',
  'CHECK (canonical_orders_created = 0)',
  'shopify_writes integer NOT NULL DEFAULT 0 CHECK (shopify_writes = 0)',
  'sync_cursor_advanced boolean NOT NULL DEFAULT false',
  'CHECK (sync_cursor_advanced = false)',
  "expires_at <= created_at + interval '24 hours'",
  'ON DELETE CASCADE',
  'protect_operations_commerce_order_preview_update',
  'BEFORE UPDATE ON operations_commerce_order_preview_runs',
  'BEFORE UPDATE ON operations_commerce_order_previews',
], 'Shopify order-preview migration')
for (const forbiddenColumn of [
  /\braw_payload\s+/i,
  /\bprovider_payload\s+/i,
  /\bcustomer_(?:id|name|email|phone)\s+/i,
  /\b(?:billing|shipping)_address\s+/i,
  /\border_(?:note|tags)\s+/i,
  /\bline_(?:title|vendor|custom_attributes)\s+/i,
]) {
  assert.doesNotMatch(
    previewMigration,
    forbiddenColumn,
    'Shopify order-preview tables must not store raw or direct customer data',
  )
}

class MockShopifyCommerceClientError extends Error {
  constructor(
    message,
    status = 502,
    code = 'SHOPIFY_UPSTREAM_FAILED',
    retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyCommerceClientError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

let previewGraphqlHandler = async () => {
  throw new Error('Unexpected Shopify call in source-contract test')
}
let previewRetryDelays = []
const previewClient = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyOrderPreview.ts',
  {
    mocks: {
      '@/lib/integrations/shopifyCommerceClient': {
        ShopifyCommerceClientError: MockShopifyCommerceClientError,
        shopifyAdminGraphql: (...args) => previewGraphqlHandler(...args),
      },
    },
    globals: {
      setTimeout(callback, delayMs) {
        previewRetryDelays.push(delayMs)
        callback()
        return 1
      },
    },
  },
)
assert.equal(previewClient.SHOPIFY_ORDER_PREVIEW_MAX_ORDERS, 25)
assert.equal(previewClient.SHOPIFY_ORDER_PREVIEW_MAX_LINES, 20)
assert.equal(previewClient.SHOPIFY_ORDER_PREVIEW_TTL_HOURS, 24)
const previewQueries = JSON.parse(JSON.stringify(
  previewClient.SHOPIFY_ORDER_PREVIEW_QUERY_CONTRACT,
))
includes(previewQueries.ids, [
  'query ClawPilotShopifyOrderPreviewIds',
  'first: $first',
  'query: $filter',
  'sortKey: CREATED_AT',
  'reverse: true',
  'test',
  'hasNextPage',
], 'Shopify order-preview ID query')
includes(previewQueries.detail, [
  'query ClawPilotShopifyOrderPreviewDetail',
  '$ids: [ID!]!',
  'nodes(ids: $ids)',
  '... on Order',
  'lineItems(first: 20)',
  'currentSubtotalLineItemsQuantity',
], 'Shopify order-preview detail query')
for (const queryText of Object.values(previewQueries)) {
  assert.doesNotMatch(
    queryText,
    /\bmutation\b/i,
    'Shopify order-preview GraphQL must be read-only',
  )
  assert.doesNotMatch(
    queryText,
    /\b(?:customer|email|phone|billingAddress|shippingAddress|note|tags|customAttributes|title|vendor)\b/i,
    'Shopify order-preview GraphQL must not request direct customer data',
  )
  assert.doesNotMatch(
    queryText,
    /\bafter\s*:/i,
    'Shopify order-preview GraphQL must not retain or advance a page cursor',
  )
}
assert.doesNotMatch(
  previewQueries.detail,
  /\b(?:product|variant|inventoryItem)\b/i,
  'Shopify order-preview GraphQL must not traverse product or inventory objects',
)
const previewClientSource = read(
  'app_src/lib/integrations/shopifyOrderPreview.ts',
)
includes(previewClientSource, [
  'CLAWPILOT_SHOPIFY_ORDER_PREVIEW_ENABLED',
  "['dev', 'development', 'local', 'preview'].includes(lane)",
  'first: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS',
  "filter: `test:false created_at:<='${windowEnd}'`",
  'SHOPIFY_ORDER_PREVIEW_DEADLINE_MS = 45_000',
  'SHOPIFY_ORDER_PREVIEW_RETRY_DELAYS_MS = [250, 750]',
  'query: SHOPIFY_ORDER_PREVIEW_DETAIL_QUERY',
  'variables: { ids: orderIds }',
], 'Shopify held-preview client')

function previewMoney(amount, currencyCode = 'USD') {
  return {
    shopMoney: {
      amount,
      currencyCode,
    },
  }
}

function previewLine({
  id,
  sku,
  quantity = 1,
  currentQuantity = quantity,
  unfulfilledQuantity = currentQuantity,
  requiresShipping = true,
}) {
  return {
    id,
    sku,
    quantity,
    currentQuantity,
    unfulfilledQuantity,
    requiresShipping,
    product: {
      id: 'gid://shopify/Product/999',
      title: 'must-not-be-retained-product',
    },
    variant: {
      id: 'gid://shopify/ProductVariant/999',
      inventoryItem: {
        id: 'gid://shopify/InventoryItem/999',
      },
    },
    title: 'must-not-be-retained-line-title',
    vendor: 'must-not-be-retained-vendor',
    customAttributes: [{
      key: 'customer-instruction',
      value: 'must-not-be-retained-custom-value',
    }],
  }
}

function previewOrder({
  id,
  name,
  createdAt,
  cancelledAt = null,
  closedAt = null,
  sourceName = 'web',
  financialStatus = 'PAID',
  fulfillmentStatus = 'UNFULFILLED',
  fulfillable = true,
  requiresShipping = true,
  lineItemQuantity = 1,
  lineItems = [],
  lineItemsTruncated = false,
  subtotalAmount = '10.00',
  shippingAmount = '2.00',
  taxAmount = '1.00',
  totalAmount = '13.00',
}) {
  return {
    id,
    name,
    createdAt,
    processedAt: createdAt,
    updatedAt: createdAt,
    cancelledAt,
    closedAt,
    test: false,
    sourceName,
    displayFinancialStatus: financialStatus,
    displayFulfillmentStatus: fulfillmentStatus,
    fulfillable,
    requiresShipping,
    currencyCode: 'USD',
    currentSubtotalLineItemsQuantity: lineItemQuantity,
    currentSubtotalPriceSet: previewMoney(subtotalAmount),
    currentShippingPriceSet: previewMoney(shippingAmount),
    currentTotalTaxSet: previewMoney(taxAmount),
    currentTotalPriceSet: previewMoney(totalAmount),
    lineItems: {
      nodes: lineItems,
      pageInfo: { hasNextPage: lineItemsTruncated },
    },
    customer: {
      id: 'gid://shopify/Customer/999',
      email: 'must-not-be-retained@example.com',
      phone: '+15555550199',
    },
    shippingAddress: {
      address1: 'must-not-be-retained-address',
    },
    billingAddress: {
      address1: 'must-not-be-retained-billing-address',
    },
    note: 'must-not-be-retained-note',
    tags: ['must-not-be-retained-tag'],
  }
}

const previewOrderIds = [
  'gid://shopify/Order/101',
  'gid://shopify/Order/102',
]
const previewOrders = [
  previewOrder({
    id: previewOrderIds[0],
    name: '#101',
    createdAt: '2026-07-25T12:00:00Z',
    cancelledAt: '2026-07-25T13:00:00Z',
    closedAt: '2026-07-25T14:00:00Z',
    fulfillmentStatus: 'FULFILLED',
    fulfillable: false,
    lineItemQuantity: 3,
    lineItemsTruncated: true,
    lineItems: [
      previewLine({
        id: 'gid://shopify/LineItem/1001',
        sku: 'SKU-101',
        quantity: 2,
        currentQuantity: 2,
        unfulfilledQuantity: 0,
      }),
      previewLine({
        id: 'gid://shopify/LineItem/1002',
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        unfulfilledQuantity: 0,
      }),
    ],
  }),
  previewOrder({
    id: previewOrderIds[1],
    name: '#102',
    createdAt: '2026-07-24T12:00:00Z',
    sourceName: null,
    financialStatus: null,
    requiresShipping: false,
    lineItemQuantity: 0,
    lineItems: [],
    subtotalAmount: '0.00',
    shippingAmount: '0.00',
    taxAmount: '0.00',
    totalAmount: '0.00',
  }),
]
const previewGraphqlCalls = []
previewGraphqlHandler = async (runtimeCredential, request, options) => {
  previewGraphqlCalls.push({ runtimeCredential, request, options })
  if (request.operationName === 'ClawPilotShopifyOrderPreviewIds') {
    return {
      orders: {
        nodes: previewOrderIds.map((id) => ({ id, test: false })),
        pageInfo: { hasNextPage: true },
      },
    }
  }
  if (request.operationName === 'ClawPilotShopifyOrderPreviewDetail') {
    return { nodes: previewOrders }
  }
  throw new Error(`Unexpected Shopify operation ${request.operationName}`)
}
previewRetryDelays = []
const parsedPreview = await previewClient.fetchShopifyOrderPreview({
  shopDomain: 'example-store.myshopify.com',
  accessToken: issuedAccessToken,
})
assert.equal(previewGraphqlCalls.length, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    previewGraphqlCalls.map((call) => call.request.operationName),
  )),
  [
    'ClawPilotShopifyOrderPreviewIds',
    'ClawPilotShopifyOrderPreviewDetail',
  ],
  'Shopify preview must use one IDs query and one bulk detail query',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    previewGraphqlCalls[1].request.variables,
  )),
  { ids: previewOrderIds },
  'Shopify preview must submit all bounded order IDs in one nodes query',
)
assert.ok(
  previewGraphqlCalls.every(
    (call) => call.options.timeoutMs > 0 && call.options.timeoutMs <= 12_000,
  ),
  'Shopify preview calls must have a bounded request timeout',
)
assert.equal(parsedPreview.ordersSeen, 2)
assert.equal(parsedPreview.moreAvailable, true)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    parsedPreview.candidates.map((candidate) => candidate.externalOrderId),
  )),
  previewOrderIds,
  'Shopify bulk detail parsing must preserve requested order-ID order',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(parsedPreview.candidates[0].gapCodes)),
  [
    'canonical_import_not_implemented',
    'customer_resolution_not_evaluated',
    'line_items_truncated',
    'order_already_fulfilled',
    'order_cancelled',
    'ship_to_not_ingested',
    'sku_missing',
  ],
  'Shopify preview must normalize and sort diagnostic gaps',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(parsedPreview.candidates[1].gapCodes)),
  [
    'canonical_import_not_implemented',
    'customer_resolution_not_evaluated',
    'line_items_empty',
    'non_shippable_order',
  ],
)
assert.equal(parsedPreview.candidates[0].lineItemsTruncated, true)
assert.deepEqual(
  Object.keys(parsedPreview.candidates[0]).sort(),
  [
    'currencyCode',
    'externalOrderId',
    'financialStatus',
    'fulfillable',
    'fulfillmentStatus',
    'gapCodes',
    'lineItemQuantity',
    'lineItemsTruncated',
    'normalizedLines',
    'orderName',
    'providerCancelledAt',
    'providerClosedAt',
    'providerCreatedAt',
    'providerProcessedAt',
    'providerUpdatedAt',
    'requiresShipping',
    'shippingAmount',
    'sourceHash',
    'sourceName',
    'subtotalAmount',
    'taxAmount',
    'testOrder',
    'totalAmount',
  ],
  'Shopify preview orders must retain only the approved minimized projection',
)
assert.deepEqual(
  Object.keys(parsedPreview.candidates[0].normalizedLines[0]).sort(),
  [
    'currentQuantity',
    'externalLineId',
    'quantity',
    'requiresShipping',
    'sku',
    'unfulfilledQuantity',
  ],
  'Shopify preview lines must retain only the approved minimized projection',
)
const serializedParsedPreview = JSON.stringify(parsedPreview)
for (const forbiddenValue of [
  'must-not-be-retained-product',
  'must-not-be-retained-line-title',
  'must-not-be-retained-vendor',
  'must-not-be-retained-custom-value',
  'must-not-be-retained@example.com',
  '+15555550199',
  'must-not-be-retained-address',
  'must-not-be-retained-billing-address',
  'must-not-be-retained-note',
  'must-not-be-retained-tag',
  'gid://shopify/Product/999',
  'gid://shopify/ProductVariant/999',
  'gid://shopify/InventoryItem/999',
  'gid://shopify/Customer/999',
]) {
  assert.ok(
    !serializedParsedPreview.includes(forbiddenValue),
    `Shopify preview retained forbidden provider field value ${forbiddenValue}`,
  )
}

let previewRetryAttempts = 0
previewRetryDelays = []
previewGraphqlHandler = async (_runtimeCredential, request) => {
  previewRetryAttempts += 1
  if (previewRetryAttempts === 1) {
    throw new MockShopifyCommerceClientError(
      'Shopify throttled the diagnostic read',
      503,
      'SHOPIFY_RATE_LIMITED',
      true,
    )
  }
  assert.equal(
    request.operationName,
    'ClawPilotShopifyOrderPreviewIds',
  )
  return {
    orders: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
  }
}
const retriedPreview = await previewClient.fetchShopifyOrderPreview({
  shopDomain: 'example-store.myshopify.com',
  accessToken: issuedAccessToken,
})
assert.equal(retriedPreview.ordersSeen, 0)
assert.equal(previewRetryAttempts, 2)
assert.deepEqual(
  previewRetryDelays,
  [250],
  'Shopify preview must retry retryable failures using its bounded first delay',
)

previewRetryAttempts = 0
previewRetryDelays = []
previewGraphqlHandler = async () => {
  previewRetryAttempts += 1
  throw new MockShopifyCommerceClientError(
    'Shopify remains unavailable',
    503,
    'SHOPIFY_UNAVAILABLE',
    true,
  )
}
await assert.rejects(
  previewClient.fetchShopifyOrderPreview({
    shopDomain: 'example-store.myshopify.com',
    accessToken: issuedAccessToken,
  }),
  (error) => error?.code === 'SHOPIFY_UNAVAILABLE',
  'Shopify preview must return the upstream error after exhausting retries',
)
assert.equal(previewRetryAttempts, 3)
assert.deepEqual(
  previewRetryDelays,
  [250, 750],
  'Shopify preview retry budget must be bounded to two waits',
)

previewRetryAttempts = 0
previewGraphqlHandler = async () => {
  previewRetryAttempts += 1
  throw new Error('Deadline-exhausted preview must not call Shopify')
}
await assert.rejects(
  previewClient.fetchShopifyOrderPreview(
    {
      shopDomain: 'example-store.myshopify.com',
      accessToken: issuedAccessToken,
    },
    { deadlineAt: Date.now() + 500 },
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_PREVIEW_DEADLINE_EXCEEDED',
  'Shopify preview must fail before provider I/O when its absolute deadline is exhausted',
)
assert.equal(previewRetryAttempts, 0)

const previewPersistence = read(
  'app_src/lib/persistence/commerceOrderPreviews.ts',
)
includes(previewPersistence, [
  'purgeExpiredShopifyOrderPreviewsInPostgres',
  'DELETE FROM operations_commerce_order_preview_runs',
  'WHERE expires_at <= now()',
  'await purgeExpiredShopifyOrderPreviewsInPostgres()',
  "account.integration_type = 'commerce'",
  "account.provider = 'shopify'",
  "AND environment = 'sandbox'",
  'WHERE organization_id = $1::uuid',
  'AND integration_account_id = $2::uuid',
  'AND account.global_id = $3',
  'operations_commerce_order_preview_runs',
  'operations_commerce_order_previews',
  "'commerce.shopify_order_preview.imported'",
  'maxLinesPerOrder: 20',
  'canonicalOrdersCreated: 0',
  'shopifyWrites: 0',
  'syncCursorAdvanced: false',
  'clearShopifyOrderPreviewInPostgres',
  "'commerce.shopify_order_preview.cleared'",
], 'Shopify order-preview persistence')
const mappingReadSource = previewPersistence.slice(
  previewPersistence.indexOf('async function mappingCatalog'),
  previewPersistence.indexOf('function enrichCandidate'),
)
assert.match(
  mappingReadSource,
  /\bSELECT\b/,
  'Shopify order-preview mapping enrichment must read the local catalog',
)
assert.doesNotMatch(
  mappingReadSource,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i,
  'Shopify order-preview mapping enrichment must not mutate products or mappings',
)
assert.doesNotMatch(
  previewPersistence,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:operations_orders|operations_commerce_sync_cursors|crm_contacts|crm_customers|crm_products|operations_product_mappings)\b/i,
  'Shopify order preview must not write canonical orders, cursors, customers, products, or mappings',
)

const previewServiceSource = service.slice(
  service.indexOf('async function shopifyPreviewAccount'),
  service.indexOf('async function verifyStoredConnection'),
)
includes(previewServiceSource, [
  'assertShopifyOrderPreviewRuntime()',
  "runtime.provider !== 'shopify'",
  "runtime.environment !== 'sandbox'",
  "runtime.verificationStatus !== 'verified'",
  "hasEffectiveShopifyScope(probe.grantedScopes, 'read_orders')",
  "hasEffectiveShopifyScope(grant.grantedScopes, 'read_orders')",
  'await fetchShopifyOrderPreview',
  'testOrdersIncluded: false',
  'includeTestOrders: false',
  'readOnly: true',
  "action: 'orders.held_preview.read'",
  'canonicalOrdersCreated: 0',
  'shopifyWrites: 0',
  'syncCursorAdvanced: false',
], 'Shopify order-preview service')
includes(service, [
  'SHOPIFY_ORDER_PREVIEW_PROVIDER_BUDGET_MS = 50_000',
  'SHOPIFY_ORDER_PREVIEW_PROVIDER_CALL_TIMEOUT_MS = 10_000',
], 'Shopify order-preview provider deadline')
assert.doesNotMatch(
  previewServiceSource,
  /\b(?:writeCommerceCredentialInPostgres|setCommerceIntegrationEnabledInPostgres|recordShopifyWebhookReceiptInPostgres)\s*\(/,
  'Shopify order preview must not enable intake or write provider-domain state',
)
const commerceStateSource = service.slice(
  service.indexOf('export async function getCommerceIntegrationsState'),
  service.indexOf('export async function connectShopifyCommerce'),
)
includes(commerceStateSource, [
  'const project = createCommerceIntegrationsStateProjector()',
  'await purgeExpiredShopifyOrderPreviewsInPostgres()',
  'return project(state)',
], 'Sales-channel state enrichment')
const commerceStateProjectorSource = service.slice(
  service.indexOf('export function createCommerceIntegrationsStateProjector'),
  service.indexOf('export function faireOAuthCallbackUrl'),
)
includes(commerceStateProjectorSource, [
  'const publicUrl = appPublicUrl()',
  "webhookUrl: account.provider === 'shopify'",
  'webhookUrl(account.globalId, publicUrl)',
], 'Sales-channel state projector')

const previewRoute = read(
  'app_src/app/api/integrations/commerce/shopify/order-preview/route.ts',
)
includes(previewRoute, [
  "export const dynamic = 'force-dynamic'",
  "export const runtime = 'nodejs'",
  'export const maxDuration = 60',
  '8 * 1024',
  'requireRequestUser(req)',
  'operationsCapabilities(actor).canManage',
  'isPostgresStorageEnabled()',
  "'Cache-Control': 'no-store, max-age=0'",
  'export async function GET',
  'export async function POST',
  'export async function DELETE',
  "'confirmReadOnly'",
  'body.confirmReadOnly !== true',
  "'confirmClear'",
  'body.confirmClear !== true',
  'organizationId: organizationId(user)',
  'accountGlobalId: body.accountGlobalId',
], 'Shopify order-preview route')
const previewProviderBudget = Number(
  service.match(
    /SHOPIFY_ORDER_PREVIEW_PROVIDER_BUDGET_MS\s*=\s*([0-9_]+)/,
  )?.[1].replaceAll('_', ''),
)
const previewRouteSeconds = Number(
  previewRoute.match(/export const maxDuration\s*=\s*([0-9]+)/)?.[1],
)
assert.ok(
  Number.isFinite(previewProviderBudget)
  && Number.isFinite(previewRouteSeconds)
  && previewProviderBudget < previewRouteSeconds * 1_000,
  'Shopify provider reads must leave time for persistence within the route deadline',
)
assert.doesNotMatch(
  previewRoute,
  /\b(?:clientSecret|accessToken|rawPayload|customerEmail|customerPhone)\b/,
  'Shopify order-preview route must not accept credentials, raw payloads, or customer fields',
)

const disconnectSource = persistence.slice(
  persistence.indexOf(
    'export async function disconnectCommerceCredentialInPostgres',
  ),
  persistence.indexOf(
    'export async function recordCommerceProviderAttemptInPostgres',
  ),
)
includes(disconnectSource, [
  "row.provider === 'shopify'",
  'DELETE FROM operations_commerce_order_preview_runs',
  'WHERE organization_id = $1::uuid',
  'AND integration_account_id = $2::uuid',
  'DELETE FROM operations_commerce_credentials',
], 'Shopify disconnect preview purge')
assert.ok(
  disconnectSource.indexOf(
    'DELETE FROM operations_commerce_order_preview_runs',
  ) < disconnectSource.indexOf(
    'DELETE FROM operations_commerce_credentials',
  ),
  'Disconnect must clear held Shopify previews before deleting the credential',
)

const previewPanelText = panel.toLowerCase().replace(/\s+/g, ' ')
for (const textFragment of [
  'development order preview',
  'read only',
  'newest 25 non-test',
  'first 20 lines per order',
  '24 hours',
  'fetch newest 25',
  'clear preview',
]) {
  assert.ok(
    previewPanelText.includes(textFragment),
    `Shopify order-preview UI missing ${textFragment}`,
  )
}
includes(panel, [
  'confirmReadOnly: true',
  'confirmClear: true',
  'crypto.randomUUID()',
  'preview.run.canonicalOrdersCreated',
  'preview.run.shopifyWrites',
  'preview.run.syncCursorAdvanced',
  'preview.run.moreAvailable',
  'preview.gapCounts',
  'preview.orders',
], 'Shopify order-preview UI')

const healthRoute = read('app_src/app/api/health/route.ts')
includes(healthRoute, [
  'operations_shopify_order_preview_migration_applied: boolean',
  "filename = '0113_operations_shopify_order_preview.sql'",
  'AS operations_shopify_order_preview_migration_applied',
  '&& row?.operations_shopify_order_preview_migration_applied',
  '|| !row?.operations_shopify_order_preview_migration_applied',
  'operations_commerce_normalization_migration_applied: boolean',
  "filename = '0114_operations_commerce_normalization.sql'",
  'AS operations_commerce_normalization_migration_applied',
  '&& row?.operations_commerce_normalization_migration_applied',
  '|| !row?.operations_commerce_normalization_migration_applied',
  'operations_commerce_continuations_migration_applied: boolean',
  "filename = '0115_operations_commerce_intake_continuations.sql'",
  'AS operations_commerce_continuations_migration_applied',
  '&& row?.operations_commerce_continuations_migration_applied',
  '|| !row?.operations_commerce_continuations_migration_applied',
], 'Shopify order-preview health migration gate')

console.log('PASS commerce integration control-plane contracts')
