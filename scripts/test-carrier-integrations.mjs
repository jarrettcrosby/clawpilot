#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, { mocks = {}, fetchImpl = fetch } = {}) {
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
    Headers,
    Request,
    Response,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch: fetchImpl,
    module,
    process,
    setTimeout,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read('db/migrations/0087_operations_carrier_credentials.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_carrier_credentials',
  'credential_ciphertext bytea NOT NULL',
  'credential_iv bytea NOT NULL',
  'credential_tag bytea NOT NULL',
  'PRIMARY KEY (organization_id, integration_account_id)',
  'REFERENCES operations_integration_accounts(organization_id, id)',
  "verification_status IN ('unverified', 'verified', 'failed')",
  'credential_version integer NOT NULL DEFAULT 1',
]) {
  assert.ok(migration.includes(fragment), `Carrier migration missing ${fragment}`)
}
assert.ok(!migration.includes('client_secret text'), 'Carrier credentials must not store plaintext secrets')

const persistence = read('app_src/lib/persistence/carrierIntegrations.ts')
for (const fragment of [
  'WHERE account.organization_id = $1::uuid',
  "account.integration_type = 'carrier'",
  "account.provider IN ('ups_rest', 'fedex_rest', 'usps_rest')",
  'acquireTransactionAdvisoryLock',
  "'carrier.credential.connected'",
  "'carrier.credential.rotated'",
  "'carrier.credential.verified'",
  "'carrier.credential.verification_failed'",
  "'carrier.integration.enabled'",
  "'carrier.integration.disabled'",
  "'carrier.credential.disconnected'",
  'carrier-credential:',
  "$1::uuid, $2, 'carrier', $3, $4, 'disabled'",
  "WHEN account.status = 'error' THEN 'disabled'",
  'NOT $4::boolean',
]) {
  assert.ok(persistence.includes(fragment), `Carrier persistence contract missing ${fragment}`)
}
assert.ok(
  !persistence.includes("$1::uuid, $2, 'carrier', $3, $4, 'active'"),
  'A newly connected carrier credential must require explicit enablement',
)
assert.ok(!persistence.includes('console.'), 'Carrier persistence must not log credentials')

const service = read('app_src/lib/integrations/carrierIntegrations.ts')
for (const fragment of [
  'resolveActiveCarrierCredential',
  "runtime.status !== 'active' || !runtime.verified",
  'await verifyCarrierCredential({ provider, environment, credential })',
  'encryptCarrierCredential(credential, organizationId, provider, environment)',
  'Carrier integration request failed',
]) {
  assert.ok(service.includes(fragment), `Carrier service contract missing ${fragment}`)
}
assert.ok(
  service.indexOf('await verifyCarrierCredential({ provider, environment, credential })')
    < service.indexOf('encryptCarrierCredential(credential, organizationId, provider, environment)'),
  'Carrier credentials must be verified before encryption and persistence',
)

const route = read('app_src/app/api/integrations/carriers/route.ts')
for (const fragment of [
  "export const runtime = 'nodejs'",
  '32 * 1024',
  'requireManager',
  "action === 'update-credential'",
  "action === 'test-connection'",
  "action === 'set-enabled'",
  "action === 'disconnect'",
  'sanitizedCarrierIntegrationError',
  'operationsCapabilities(actor).canManage',
]) {
  assert.ok(route.includes(fragment), `Carrier API contract missing ${fragment}`)
}
assert.ok(!route.includes('permissions.manageUserAccess'), 'Carrier management must use operations permission')

const panel = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
for (const fragment of [
  'UPS',
  'FedEx',
  'USPS',
  'Sandbox / developer',
  'Production',
  'type="password"',
  'Save and verify',
  'Test connection',
  'Disconnect',
]) {
  assert.ok(panel.includes(fragment), `Carrier settings UI missing ${fragment}`)
}

const settingsPanel = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
assert.ok(
  settingsPanel.includes('canManageOperationsIntegrations'),
  'Shipping settings must honor operations permission',
)
const operationsPersistence = read('app_src/lib/persistence/operations.ts')
assert.ok(
  operationsPersistence.includes("credential.verification_status = 'verified'"),
  'Live activation must require verified production carrier credentials',
)

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'carrier-test-encryption-key-0123456789abcdef'
const cryptoModule = loadTypeScriptModule('app_src/lib/integrations/carrierCredentialCrypto.ts', {
  mocks: { '@/lib/persistence/config': { isHostedRuntime: () => false } },
})
const credential = {
  clientId: 'carrier-client-id-1234',
  clientSecret: 'carrier-client-secret-5678',
  accountNumber: 'ACCOUNT-9012',
}
const encrypted = cryptoModule.encryptCarrierCredential(
  credential,
  organizationId,
  'ups_rest',
  'sandbox',
)
assert.equal(encrypted.iv.length, 12)
assert.equal(encrypted.tag.length, 16)
assert.ok(!encrypted.ciphertext.includes(Buffer.from(credential.clientSecret)))
assert.deepEqual(
  JSON.parse(JSON.stringify(cryptoModule.decryptCarrierCredential(
    encrypted,
    organizationId,
    'ups_rest',
    'sandbox',
  ))),
  credential,
)
assert.throws(
  () => cryptoModule.decryptCarrierCredential(encrypted, otherOrganizationId, 'ups_rest', 'sandbox'),
  /could not be decrypted/,
  'organization AAD must reject cross-tenant decryption',
)
assert.throws(
  () => cryptoModule.decryptCarrierCredential(encrypted, organizationId, 'fedex_rest', 'sandbox'),
  /could not be decrypted/,
  'provider AAD must reject cross-provider decryption',
)
assert.throws(
  () => cryptoModule.decryptCarrierCredential(encrypted, organizationId, 'ups_rest', 'production'),
  /could not be decrypted/,
  'environment AAD must reject cross-environment decryption',
)
assert.throws(
  () => cryptoModule.normalizeCarrierAccountNumber('', 'ups_rest'),
  /billing account number is required/,
)
assert.equal(cryptoModule.normalizeCarrierAccountNumber('', 'usps_rest'), null)

const requests = []
const successfulFetch = async (url, init) => {
  requests.push({ url, init })
  return new Response(JSON.stringify({
    access_token: 'short-lived-provider-token',
    expires_in: 3600,
    scope: 'rate ship track',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const carrierClientSource = read('app_src/lib/integrations/carrierCredentialClient.ts')
const clientModule = loadTypeScriptModule('app_src/lib/integrations/carrierCredentialClient.ts')

const upsResult = await clientModule.verifyCarrierCredential({
  provider: 'ups_rest',
  environment: 'sandbox',
  credential,
}, { fetchImpl: successfulFetch })
assert.equal(requests[0].url, 'https://wwwcie.ups.com/security/v1/oauth/token')
assert.match(requests[0].init.headers.Authorization, /^Basic /)
assert.equal(requests[0].init.body, 'grant_type=client_credentials')
assert.deepEqual(JSON.parse(JSON.stringify(upsResult)), {
  provider: 'ups_rest',
  environment: 'sandbox',
  expiresInSeconds: 3600,
  scope: 'rate ship track',
})
assert.ok(!Object.hasOwn(upsResult, 'accessToken'), 'verification results must not expose access tokens')

await clientModule.verifyCarrierCredential({
  provider: 'fedex_rest',
  environment: 'production',
  credential,
}, { fetchImpl: successfulFetch })
assert.equal(requests[1].url, 'https://apis.fedex.com/oauth/token')
assert.match(String(requests[1].init.body), /client_id=carrier-client-id-1234/)
assert.match(String(requests[1].init.body), /client_secret=carrier-client-secret-5678/)

await clientModule.verifyCarrierCredential({
  provider: 'usps_rest',
  environment: 'sandbox',
  credential: { ...credential, accountNumber: null },
}, { fetchImpl: successfulFetch })
assert.equal(requests[2].url, 'https://apis-tem.usps.com/oauth2/v3/token')
assert.match(carrierClientSource, /https:\/\/apis-sandbox\.fedex\.com\/oauth\/token/)
assert.match(carrierClientSource, /https:\/\/apis\.fedex\.com\/oauth\/token/)
assert.match(carrierClientSource, /https:\/\/apis\.usps\.com\/oauth2\/v3\/token/)
assert.match(carrierClientSource, /https:\/\/onlinetools\.ups\.com\/security\/v1\/oauth\/token/)
assert.deepEqual(JSON.parse(requests[2].init.body), {
  client_id: credential.clientId,
  client_secret: credential.clientSecret,
  grant_type: 'client_credentials',
})

await assert.rejects(
  clientModule.verifyCarrierCredential({
    provider: 'ups_rest',
    environment: 'production',
    credential,
  }, {
    fetchImpl: async () => new Response('provider-body-must-not-leak', { status: 401 }),
  }),
  (error) => {
    assert.equal(error.code, 'CARRIER_CREDENTIAL_REJECTED')
    assert.equal(error.status, 409)
    assert.ok(!error.message.includes('provider-body-must-not-leak'))
    return true
  },
)

await assert.rejects(
  clientModule.verifyCarrierCredential({
    provider: 'fedex_rest',
    environment: 'sandbox',
    credential,
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: 'short-lived-provider-token',
      padding: 'x'.repeat(65 * 1024),
    }), { status: 200 }),
  }),
  (error) => {
    assert.equal(error.code, 'CARRIER_PROVIDER_RESPONSE_INVALID')
    return true
  },
  'response size must be enforced even without Content-Length',
)

console.log('carrier integration contract tests passed')
