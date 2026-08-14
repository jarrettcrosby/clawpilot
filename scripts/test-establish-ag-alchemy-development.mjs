#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as globalIds from '../app_src/lib/globalIds.mjs'
import * as commerceOrderRevisionEvidenceKeyConfig from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
import {
  APPROVED_SHOPIFY_READ_SCOPES,
  DISPOSABLE_REHEARSAL_CONFIRMATION,
  EXECUTION_CONFIRMATION,
  SHOPIFY_ADMIN_API_VERSION,
  TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
  TRUSTED_RAILWAY_PROJECT_ID,
  commerceEncryptionKey,
  configurationFromEnvironment,
  decryptShopifyCredential,
  encryptShopifyCredential,
  parseArguments,
  planDigest,
  probeShopifyReadOnly,
  runSelfTest,
  validateRuntimeEnvironment,
} from './establish-ag-alchemy-development.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadCommerceCrypto() {
  const path = 'app_src/lib/integrations/commerceCredentialCrypto.ts'
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
    Buffer,
    Error,
    JSON,
    Object,
    console,
    crypto: nodeRequire('node:crypto'),
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/globalIds.mjs') {
        return globalIds
      }
      if (specifier === '@/lib/persistence/config') {
        return { isHostedRuntime: () => true }
      }
      if (specifier === '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs') {
        return commerceOrderRevisionEvidenceKeyConfig
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

assert.deepEqual(parseArguments([]), { mode: 'plan', help: false })
assert.deepEqual(parseArguments(['--execute']), {
  mode: 'execute',
  help: false,
})
assert.deepEqual(parseArguments(['--self-test']), {
  mode: 'self-test',
  help: false,
})
assert.throws(
  () => parseArguments(['--plan', '--execute']),
  /cannot be combined/,
)
assert.throws(() => parseArguments(['--force']), /Unsupported/)

const baseEnvironment = {
  AG_ALCHEMY_ACTOR_EMAIL: 'owner@example.test',
  AG_ALCHEMY_SOURCE_ORGANIZATION_REFERENCE: 'ga1234567',
  AG_ALCHEMY_SOURCE_ACCOUNT_GLOBAL_ID: 'gia2345678',
  AG_ALCHEMY_RETAIN_DEFAULT_ORGANIZATION_REFERENCE: 'ga3456789',
  AG_ALCHEMY_SHOP_DOMAIN: 'example-shop.myshopify.com',
  AG_ALCHEMY_SHOP_EXTERNAL_ACCOUNT_ID:
    'gid://shopify/Shop/123456789',
  APP_LOGIN_EMAIL: 'owner@example.test',
  CLAWPILOT_STORAGE: 'postgres',
  DATABASE_URL: 'postgres://example.invalid/clawpilot',
  RAILWAY_ENVIRONMENT_NAME: 'development',
  RAILWAY_ENVIRONMENT_ID: TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
  RAILWAY_PROJECT_ID: TRUSTED_RAILWAY_PROJECT_ID,
}
assert.deepEqual(APPROVED_SHOPIFY_READ_SCOPES, [
  'read_all_orders',
  'read_inventory',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_orders',
  'read_products',
  'read_shipping',
])
const planConfiguration = configurationFromEnvironment(
  baseEnvironment,
  'plan',
)
validateRuntimeEnvironment(
  baseEnvironment,
  planConfiguration,
  'plan',
)
assert.equal(planConfiguration.targetName, 'AG Alchemy, LLC')
assert.throws(
  () => validateRuntimeEnvironment(
    { ...baseEnvironment, RAILWAY_ENVIRONMENT_NAME: 'production' },
    planConfiguration,
    'plan',
  ),
  /development/,
)
assert.throws(
  () => validateRuntimeEnvironment(
    { ...baseEnvironment, APP_LOGIN_EMAIL: 'other@example.test' },
    planConfiguration,
    'plan',
  ),
  /root application owner/,
)
assert.throws(
  () => validateRuntimeEnvironment(
    {
      ...baseEnvironment,
      RAILWAY_ENVIRONMENT_ID:
        '22345678-1234-4123-8123-123456789abc',
    },
    planConfiguration,
    'plan',
  ),
  /trusted development environment/,
)
const rehearsalEnvironment = {
  ...baseEnvironment,
  DATABASE_URL: 'postgres://localhost/clawpilot-rehearsal',
  AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM:
    DISPOSABLE_REHEARSAL_CONFIRMATION,
}
delete rehearsalEnvironment.RAILWAY_ENVIRONMENT_NAME
delete rehearsalEnvironment.RAILWAY_ENVIRONMENT_ID
delete rehearsalEnvironment.RAILWAY_PROJECT_ID
validateRuntimeEnvironment(
  rehearsalEnvironment,
  planConfiguration,
  'plan',
)
assert.throws(
  () => validateRuntimeEnvironment(
    {
      ...rehearsalEnvironment,
      RAILWAY_ENVIRONMENT_NAME: 'development',
    },
    planConfiguration,
    'plan',
  ),
  /cannot run with Railway environment markers/,
)
assert.throws(
  () => configurationFromEnvironment({
    ...baseEnvironment,
    AG_ALCHEMY_TARGET_ORGANIZATION_NAME: 'AG Alchemy',
  }, 'plan'),
  /exactly AG Alchemy, LLC/,
)
assert.throws(
  () => configurationFromEnvironment({
    ...baseEnvironment,
    AG_ALCHEMY_CONFIRM: EXECUTION_CONFIRMATION,
  }, 'execute'),
  /DATABASE_FINGERPRINT/,
)

const digest = planDigest({
  source: { account: 'gia2345678', rows: 25 },
  target: { name: 'AG Alchemy, LLC' },
})
const executeEnvironment = {
  ...baseEnvironment,
  AG_ALCHEMY_DATABASE_FINGERPRINT:
    '11111111-1111-4111-8111-111111111111',
  AG_ALCHEMY_PLAN_DIGEST: digest,
  AG_ALCHEMY_CONFIRM: EXECUTION_CONFIRMATION,
  AGENT_CREDENTIAL_ENCRYPTION_KEY:
    'ag-alchemy-test-encryption-key-1234567890',
}
const executeConfiguration = configurationFromEnvironment(
  executeEnvironment,
  'execute',
)
validateRuntimeEnvironment(
  executeEnvironment,
  executeConfiguration,
  'execute',
)
assert.throws(
  () => configurationFromEnvironment({
    ...executeEnvironment,
    AG_ALCHEMY_CONFIRM: 'yes',
  }, 'execute'),
  /AG_ALCHEMY_CONFIRM/,
)
assert.notEqual(
  digest,
  planDigest({
    source: { account: 'gia2345678', rows: 24 },
    target: { name: 'AG Alchemy, LLC' },
  }),
  'Any plan drift must change the approval digest',
)

const probeCalls = []
const probeGrantedScopes = [
  ...APPROVED_SHOPIFY_READ_SCOPES,
  'read_returns',
].sort()
const probeCredential = {
  provider: 'shopify',
  authMode: 'shopify_client_credentials',
  clientId: 'probe-client-id-1234567890',
  clientSecret: 'probe-client-secret-1234567890',
}
const probeResult = await probeShopifyReadOnly({
  shopDomain: 'example-shop.myshopify.com',
  externalAccountId: 'gid://shopify/Shop/123456789',
  credential: probeCredential,
}, {
  async fetchImpl(url, init) {
    probeCalls.push({ url, init })
    if (probeCalls.length === 1) {
      return new Response(JSON.stringify({
        access_token: 'synthetic-access-token-1234567890',
        expires_in: 86399,
        scope: probeGrantedScopes.join(','),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      data: {
        shop: {
          id: 'gid://shopify/Shop/123456789',
          myshopifyDomain: 'example-shop.myshopify.com',
          name: 'Example Shop',
        },
        currentAppInstallation: {
          accessScopes: [
            ...probeGrantedScopes.map((handle) => ({ handle })),
          ],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
assert.equal(probeCalls.length, 2)
assert.equal(
  probeCalls[0].url,
  'https://example-shop.myshopify.com/admin/oauth/access_token',
)
assert.equal(probeCalls[0].init.method, 'POST')
assert.equal(
  probeCalls[0].init.body.get('grant_type'),
  'client_credentials',
)
assert.equal(
  probeCalls[0].init.body.get('client_id'),
  probeCredential.clientId,
)
assert.equal(
  probeCalls[0].init.body.get('client_secret'),
  probeCredential.clientSecret,
)
assert.equal(
  probeCalls[1].url,
  `https://example-shop.myshopify.com/admin/api/${
    SHOPIFY_ADMIN_API_VERSION
  }/graphql.json`,
)
assert.equal(probeCalls[1].init.method, 'POST')
assert.equal(
  probeCalls[1].init.headers['X-Shopify-Access-Token'],
  'synthetic-access-token-1234567890',
)
const probeGraphqlBody = JSON.parse(probeCalls[1].init.body)
assert.equal(
  probeGraphqlBody.operationName,
  'ClawPilotShopifyConnectionProbe',
)
assert.match(probeGraphqlBody.query, /^\s*query\b/)
assert.doesNotMatch(probeGraphqlBody.query, /\bmutation\b/i)
assert.deepEqual(probeResult, {
  providerAccountId: 'gid://shopify/Shop/123456789',
  shopDomain: 'example-shop.myshopify.com',
  shopName: 'Example Shop',
  apiVersion: SHOPIFY_ADMIN_API_VERSION,
  grantedScopes: probeGrantedScopes,
  tokenGrantedScopes: probeGrantedScopes,
  requestedScopes: [...APPROVED_SHOPIFY_READ_SCOPES],
  missingScopes: [],
  expiresIn: 86399,
})
await assert.rejects(
  probeShopifyReadOnly({
    shopDomain: 'example-shop.myshopify.com',
    externalAccountId: 'gid://shopify/Shop/123456789',
    credential: probeCredential,
  }, {
    async fetchImpl() {
      return new Response(JSON.stringify({
        access_token: 'synthetic-access-token-1234567890',
        expires_in: 86399,
        scope: [...probeGrantedScopes, 'write_products'].join(','),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  }),
  /prohibited Shopify write scope/,
  'The transfer must reject a Shopify grant containing any write scope',
)
let graphqlWriteProbeCalls = 0
await assert.rejects(
  probeShopifyReadOnly({
    shopDomain: 'example-shop.myshopify.com',
    externalAccountId: 'gid://shopify/Shop/123456789',
    credential: probeCredential,
  }, {
    async fetchImpl() {
      graphqlWriteProbeCalls += 1
      if (graphqlWriteProbeCalls === 1) {
        return new Response(JSON.stringify({
          access_token: 'synthetic-access-token-1234567890',
          expires_in: 86399,
          scope: probeGrantedScopes.join(','),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        data: {
          shop: {
            id: 'gid://shopify/Shop/123456789',
            myshopifyDomain: 'example-shop.myshopify.com',
            name: 'Example Shop',
          },
          currentAppInstallation: {
            accessScopes: [
              ...probeGrantedScopes.map((handle) => ({ handle })),
              { handle: 'write_products' },
            ],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  }),
  /Shopify connection probe includes prohibited Shopify write scope/,
  'The transfer must reject write scope evidence from the live probe',
)
assert.equal(graphqlWriteProbeCalls, 2)

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
  'ag-alchemy-cross-check-key-1234567890abcdef'
const canonicalCrypto = loadCommerceCrypto()
const key = commerceEncryptionKey(process.env)
const sourceOrganizationId =
  '11111111-1111-4111-8111-111111111111'
const targetOrganizationId =
  '22222222-2222-4222-8222-222222222222'
const externalAccountId = 'gid://shopify/Shop/123456789'
const credential = {
  provider: 'shopify',
  authMode: 'shopify_client_credentials',
  clientId: 'shopify-client-id-1234567890',
  clientSecret: 'shopify-client-secret-1234567890',
}
const canonicalEncrypted = canonicalCrypto.encryptCommerceCredential(
  credential,
  sourceOrganizationId,
  'sandbox',
  externalAccountId,
)
assert.deepEqual(
  decryptShopifyCredential({
    key,
    encrypted: canonicalEncrypted,
    organizationId: sourceOrganizationId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId,
  }),
  credential,
  'Operational script must decrypt the canonical application ciphertext',
)
const scriptEncrypted = encryptShopifyCredential({
  key,
  credential,
  organizationId: targetOrganizationId,
  provider: 'shopify',
  environment: 'sandbox',
  externalAccountId,
})
assert.deepEqual(
  JSON.parse(JSON.stringify(canonicalCrypto.decryptCommerceCredential(
    scriptEncrypted,
    targetOrganizationId,
    'shopify',
    'sandbox',
    externalAccountId,
  ))),
  credential,
  'Application must decrypt the credential recreated by the operational script',
)
assert.throws(
  () => canonicalCrypto.decryptCommerceCredential(
    scriptEncrypted,
    sourceOrganizationId,
    'shopify',
    'sandbox',
    externalAccountId,
  ),
  /could not be decrypted/,
  'Recreated credential must reject the source tenant AAD',
)
key.fill(0)
canonicalEncrypted.ciphertext.fill(0)
scriptEncrypted.ciphertext.fill(0)
delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY

assert.deepEqual(runSelfTest(), {
  ok: true,
  version: 'ag-alchemy-development-v1',
})

const source = read(
  'scripts/establish-ag-alchemy-development.mjs',
)
assert.equal(
  source.match(/credentialReferencePresent:/g)?.length,
  1,
  'The source-account plan must expose credentialReferencePresent once',
)
for (const fragment of [
  "RAILWAY_ENVIRONMENT_NAME).toLowerCase()",
  "!== 'development'",
  'AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM',
  'TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID',
  'TRUSTED_RAILWAY_PROJECT_ID',
  'AG_ALCHEMY_DATABASE_FINGERPRINT',
  'AG_ALCHEMY_PLAN_DIGEST',
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'pg_advisory_xact_lock',
  "verification_status, verified_at, last_error_code",
  "'verified', $8::timestamptz, NULL",
  "action, adapter_version",
  "'connection.verify'",
  "'succeeded'",
  'probeSourceBeforeTransaction',
  'APPROVED_SHOPIFY_READ_SCOPES',
  "scope.startsWith('write_')",
  "'read_all_orders'",
  "'read_inventory'",
  "'read_locations'",
  "'read_merchant_managed_fulfillment_orders'",
  "'read_orders'",
  "'read_products'",
  "'read_shipping'",
  'commerce.credential.ownership_transferred_out',
  'commerce.credential.ownership_transferred_in',
  'retain-source-account-attempts-audits-and-global-id',
  'readInfrastructureSnapshot',
]) {
  assert.ok(source.includes(fragment), `Transfer script missing ${fragment}`)
}
for (const forbidden of [
  'DELETE FROM operations_commerce_provider_attempts',
  'DELETE FROM audit_events',
  'SET organization_id =',
  'mutation ',
  'ag-alchemy.myshopify.com',
  'gia9729539',
  'ga8142977',
  'jarrett@suburbiasandwichco.com',
]) {
  assert.ok(
    !source.includes(forbidden),
    `Transfer script must not contain ${forbidden}`,
  )
}

const ownerPermissionsSource = read('app_src/lib/users.ts')
for (const permission of [
  'accessDemo',
  'inviteUsers',
  'manageUserAccess',
  'createBoards',
  'createPipelines',
  'viewOperations',
  'manageOperations',
  'executeWarehouse',
  'manageCarrierRateNetworks',
  'grantCarrierRateAccess',
  'viewCarrierCost',
  'reconcileCarrierBilling',
  'approveCarrierSettlement',
  'viewFullReleaseHistory',
  'manageBackups',
  'manageLinks',
  'viewAccounting',
  'prepareAccounting',
  'approveAccounting',
  'viewOrganizationAudit',
  'viewSystemAudit',
]) {
  assert.ok(
    ownerPermissionsSource.includes(`${permission}: true`),
    `Native owner permissions missing ${permission}`,
  )
  assert.ok(
    source.includes(`${permission}: true`),
    `Transfer workspace owner permissions missing ${permission}`,
  )
}

console.log('AG Alchemy development establishment tests passed')
