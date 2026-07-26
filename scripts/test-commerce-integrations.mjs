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
  "'commerce.credential.disconnected'",
  "'commerce.webhook.received'",
  'payload_hash',
  'Shopify reused a webhook event ID with a different payload',
  'account.commerce_credential_generation = $6',
  'credential.credential_version = $6',
  'row.credential_version !== row.commerce_credential_generation',
  'commerce_credential_generation = $3',
  'credential.credential_version = $3',
  'FOR UPDATE OF account, credential',
  "current.status === 'active' ? 'queued' : 'held'",
  'Shopify webhook credential generation changed before receipt commit',
], 'Commerce persistence')
assert.ok(
  !/console\.(?:log|error|warn)/.test(persistence),
  'Commerce persistence must not log credentials or payloads',
)

const service = read('app_src/lib/integrations/commerceIntegrations.ts')
includes(service, [
  'await probeShopifyConnection',
  'await probeFaireBrandProfile',
  'encryptCommerceCredential',
  'domainWorkersActivated: false',
  "'faire_brand_token'",
  "'shopify_client_credentials'",
  'await requestShopifyAccessToken',
  "runtime.status === 'error'",
  'verifyShopifyWebhookHmac',
  'encryptCommerceWebhookPayload',
  'recordShopifyWebhookReceiptInPostgres',
  'SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPIC_SET.has(topic)',
  'SHOPIFY_WEBHOOK_TOPIC_UNSUPPORTED',
  'Faire runtime polling is not implemented',
], 'Commerce service')
assert.ok(
  service.indexOf('await probeShopifyConnection')
    < service.indexOf('const encrypted = encryptCommerceCredential'),
  'Shopify must be verified before encrypted credential persistence',
)
assert.ok(
  !service.includes('console.'),
  'Commerce integration service must not log credentials',
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
  "action === 'connect-faire'",
  "action === 'test-connection'",
  "action === 'set-enabled'",
  "action === 'disconnect'",
  'confirmLiveAccess',
  "'clientId'",
  "'Cache-Control': 'no-store, max-age=0'",
  'domainWorkersActivated: false',
  'canonicalOrderImport: false',
  'inventoryMutation: false',
  'fulfillmentExport: false',
  'acceptedReceiptTopics: SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS',
], 'Commerce admin route')
assert.ok(
  !adminRoute.includes("'accessToken',\n        'clientSecret'"),
  'Shopify Admin API must not accept a pasted short-lived access token',
)

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

const panel = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
includes(panel, [
  'Sales channels',
  'separate from restaurant POS',
  'type="password"',
  'confirmLiveAccess',
  'Canonical order import',
  'Provider availability is shown separately',
  'Domain workers activated: no.',
  'Order and customer topics are rejected',
  "clientId: ''",
  "accessToken: ''",
  "clientSecret: ''",
], 'Commerce settings UI')
const integrationSettings = read(
  'app_src/components/settings/IntegrationSettingsPanel.tsx',
)
includes(integrationSettings, [
  "key: 'commerce'",
  "label: 'Sales channels'",
  '<CommerceIntegrationPanel />',
  'canManageOperationsIntegrations',
], 'Integration settings navigation')

const capabilities = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCapabilities.ts',
)
assert.equal(capabilities.SHOPIFY_ADMIN_API_VERSION, '2026-07')
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
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.webhooks, false)
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.sandbox, false)
assert.equal(faireClient.FAIRE_COMMERCE_CAPABILITIES.returnWrites, false)
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

console.log('PASS commerce integration control-plane contracts')
