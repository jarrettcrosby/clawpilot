#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

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

const persistence = read('app_src/lib/persistence/commerceIntegrations.ts')
includes(persistence, [
  "account.integration_type = 'commerce'",
  'account.organization_id = $1::uuid',
  'operations_commerce_credentials',
  'operations_commerce_sync_cursors',
  'operations_commerce_webhook_receipts',
  'operations_commerce_provider_attempts',
  'acquireTransactionAdvisoryLock',
  "'commerce.credential.connected'",
  "'commerce.credential.rotated'",
  "'commerce.credential.verified'",
  "'commerce.credential.verification_failed'",
  "'commerce.integration.enabled'",
  "'commerce.integration.disabled'",
  "'commerce.shopify.scopes_updated'",
  "'commerce.credential.disconnected'",
  "'commerce.credential.revealed'",
  "'commerce.webhook.received'",
  'recordCommerceCredentialRevealInPostgres',
  'payload: { credentialVersion: row.credential_version }',
  'disableIntegration?: boolean',
  "reason: 'shopify_scope_profile_incomplete'",
  'scopeProfileIncomplete',
  'payload_hash',
  'Shopify reused a webhook event ID with a different payload',
  'account.commerce_credential_generation = $6',
  'credential.credential_version = $6',
  'row.credential_version !== row.commerce_credential_generation',
  'commerce_credential_generation = $3',
  'credential.credential_version = $3',
  'credential.credential_version =\n                 account.commerce_credential_generation',
  "account.configuration->>'scopeProfile' =",
  "account.configuration->'missingScopes' = '[]'::jsonb",
  'FOR UPDATE OF account, credential',
  "effectiveStatus === 'active' ? 'queued' : 'held'",
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
  'SHOPIFY_RECEIPT_PROOF_SCOPES',
  'auditShopifyScopeRequirements',
  'auditShopifyScopeUpdatePayload',
  "scopeProfile: 'receipt_evidence_v1'",
  'SHOPIFY_SCOPE_PROFILE_INCOMPLETE',
  "runtime.status === 'error'",
  'verifyShopifyWebhookHmac',
  'encryptCommerceWebhookPayload',
  'recordShopifyWebhookReceiptInPostgres',
  'SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET.has(topic)',
  "topic === 'app/scopes_update'",
  'SHOPIFY_WEBHOOK_TOPIC_UNSUPPORTED',
  'Faire runtime polling is not implemented',
  'revealCommerceCredential',
  'recordCommerceCredentialRevealInPostgres',
  'expiresAt: new Date(revealedAt.getTime() + 30_000).toISOString()',
], 'Commerce service')
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
  "action === 'start-faire-oauth'",
  "action === 'test-connection'",
  "action === 'set-enabled'",
  "action === 'disconnect'",
  "action === 'reveal-credential'",
  'canRevealCredentials: canRevealCredential(actor)',
  'requireCredentialViewer(actor)',
  "return role === 'owner' || role === 'admin'",
  "'COMMERCE_CREDENTIAL_REVEAL_FORBIDDEN'",
  'revealCommerceCredential',
  'confirmLiveAccess',
  "'clientId'",
  "'applicationId'",
  "'applicationSecret'",
  "'scopeProfile'",
  'requireRequestSession(req)',
  "'Cache-Control': 'no-store, max-age=0'",
  'domainWorkersActivated: false',
  'canonicalOrderImport: false',
  'inventoryMutation: false',
  'fulfillmentExport: false',
  'acceptedReceiptTopics: SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS',
  '...COMMERCE_CUSTOM_INTEGRATION_ONBOARDING',
  'callbackUrl: faireOAuthCallbackUrl()',
], 'Commerce admin route')
assert.ok(
  !adminRoute.includes("'accessToken',\n        'clientSecret'"),
  'Shopify Admin API must not accept a pasted short-lived access token',
)

const integrationsDoc = read('docs/modules/user-integrations.md')
includes(integrationsDoc, [
  'scripts/establish-ag-alchemy-development.mjs',
  'limited to the Railway development database',
  'read-only identity/scope GraphQL query',
  'operator-approved read-only set `read_all_orders`',
  '`read_merchant_managed_fulfillment_orders`',
  'Any granted scope beginning `write_` fails closed',
  'additional granted `read_` scopes remain',
  'leaves the target verified but disabled with pristine cursors',
  'existing default workspace plus non-Shopify shipping, warehouse, printer, and print-agent identities',
  'explicitly reveal only the current Shopify client ID/client secret or current Faire OAuth Application ID/Secret ID',
  'removed from the page after 30 seconds',
  'Legacy Faire brand-token credentials are not revealable',
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
    < webhookRoute.indexOf('boundedRequestBody(req)'),
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
  "'authorizationCode'",
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
  'Faire Custom App OAuth',
  'Faire Application ID',
  'Faire Secret ID',
  "OAuth eligibility only when it accepts the authorization",
  'single-brand API-key flow',
  'Single-brand guide — not connectable here',
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
  'Optional signed receipt setup',
  'Copy URL',
  'Least-privilege receipt profile',
  'Synchronization unavailable',
  'type="password"',
  'confirmLiveAccess',
  'Canonical order import',
  'Provider availability is shown separately',
  'Domain workers activated: no.',
  'Order and customer topics are rejected',
  "clientId: ''",
  "applicationId: ''",
  "applicationSecret: ''",
  "clientSecret: ''",
  'useRef(integrations.organizationId)',
  'payload.integrations.organizationId',
  '!== organizationIdRef.current',
  'const revealOrganizationId = organizationIdRef.current',
  'organizationIdRef.current === revealOrganizationId',
], 'Commerce settings UI')
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
  '<CommerceIntegrationPanel />',
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
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.shopify.developerPortalUrl,
  'https://dev.shopify.com/dashboard',
)
assert.equal(
  capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.faire.setupGuideUrl,
  'https://developers.faire.com/docs#/#authentication',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capabilities.COMMERCE_CUSTOM_INTEGRATION_ONBOARDING
      .faire.scopeProfiles.connection_test,
  )),
  ['READ_BRAND'],
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
    'inventory_items/update',
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
assert.deepEqual(
  JSON.parse(JSON.stringify(capabilities.auditShopifyScopeUpdatePayload({
    current: ['write_products'],
    previous: ['write_products', 'write_inventory'],
  }))),
  {
    requestedScopes: ['read_inventory', 'read_products'],
    grantedScopes: ['write_products'],
    missingScopes: ['read_inventory'],
    restrictedScopes: [],
  },
  'Shopify scope-update events must expose a fail-closed receipt-profile audit',
)
assert.throws(
  () => capabilities.auditShopifyScopeUpdatePayload({
    current: 'read_products',
  }),
  /scope-update payload was invalid/,
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.order_import,
  'not_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION.webhook_verification,
  'control_plane_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.order_import,
  'not_implemented',
)
assert.equal(
  capabilities.CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION.oauth_authentication,
  'control_plane_implemented',
)
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
            on_hand_quantity: { type: 'QUANTITY', quantity: 18 },
            committed_quantity: { type: 'QUANTITY', quantity: 3 },
            available_quantity: { type: 'QUANTITY', quantity: 15 },
          },
        },
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
  productVariantIds: ['product_variant_123'],
})
assert.deepEqual(
  JSON.parse(JSON.stringify(
    faireInventory.inventories.product_variant_123.available_quantity,
  )),
  { type: 'QUANTITY', quantity: 15 },
)
assert.equal(
  faireRequests[1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-product-variant-ids?ids=product_variant_123',
)
assert.equal('registerWebhook' in faireApi, false)
assert.equal('writeReturn' in faireApi, false)

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
    'requested_delivery_not_mapped',
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
    'requested_delivery_not_mapped',
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
  "probeScopes.has('read_orders')",
  "tokenScopes.has('read_orders')",
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
assert.ok(
  commerceStateSource.includes(
    'await purgeExpiredShopifyOrderPreviewsInPostgres()',
  ),
  'Sales-channel reads must opportunistically purge expired Shopify previews',
)

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
], 'Shopify order-preview health migration gate')

console.log('PASS commerce integration control-plane contracts')
