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

const sandboxRateMigration = read('db/migrations/0088_operations_sandbox_rating_and_mock_retirement.sql')
for (const fragment of [
  "('grq', 'operations.carrier_rate_request'",
  'ADD COLUMN IF NOT EXISTS archived_at timestamptz',
  'CREATE TABLE IF NOT EXISTS operations_carrier_rate_requests',
  "environment text NOT NULL CHECK (environment = 'sandbox')",
  "purpose = 'sandbox_rate_test'",
  "request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$')",
  'redacted_request jsonb NOT NULL',
  'redacted_response jsonb NOT NULL',
  'protect_operations_carrier_rate_requests_mutation',
  "WHERE orders.source_provider = 'mock-commerce'",
  "SET status = 'cancelled'",
  "WHERE provider IN ('mock-commerce', 'mock-carrier', 'mock-printer')",
  "WHERE code = 'MOCK-01'",
]) {
  assert.ok(sandboxRateMigration.includes(fragment), `Sandbox-rate migration missing ${fragment}`)
}
assert.ok(
  !/client_secret|access_token|private_key/i.test(sandboxRateMigration),
  'Sandbox-rate evidence must never persist provider credentials or tokens',
)

const carrierAccountMigration = read('db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_carrier_accounts',
  'account_number_ciphertext text NOT NULL',
  'account_number_iv text NOT NULL',
  'account_number_tag text NOT NULL',
  'registered_address jsonb NOT NULL',
  'allow_sender_billing boolean NOT NULL DEFAULT true',
  'allow_recipient_billing boolean NOT NULL DEFAULT true',
  'allow_third_party_billing boolean NOT NULL DEFAULT true',
  'ADD COLUMN IF NOT EXISTS carrier_account_id uuid',
  'ADD COLUMN IF NOT EXISTS billing_relationship text',
  "billing_selection_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb",
]) {
  assert.ok(carrierAccountMigration.includes(fragment), `Carrier-account migration missing ${fragment}`)
}
assert.ok(
  !/\baccount_number\s+text\b/i.test(carrierAccountMigration),
  'Carrier account numbers must not be stored in plaintext',
)

const carrierAccountSenderNameMigration = read(
  'db/migrations/0110_operations_carrier_account_sender_name.sql',
)
for (const fragment of [
  'ADD COLUMN IF NOT EXISTS sender_name text',
  'ALTER COLUMN sender_name SET NOT NULL',
  'operations_carrier_accounts_sender_name_valid',
]) {
  assert.ok(
    carrierAccountSenderNameMigration.includes(fragment),
    `Carrier-account sender-name migration missing ${fragment}`,
  )
}

const sandboxDiagnosticScopeMigration = read(
  'db/migrations/0100_operations_sandbox_rate_diagnostic_scope.sql',
)
for (const fragment of [
  'DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_authorization_scope_valid',
  'ADD CONSTRAINT operations_carrier_rate_requests_authorization_scope_consistent',
  'network_id IS NULL',
  'account_authorization_id IS NULL',
  'network_id IS NOT NULL',
  'account_authorization_id IS NOT NULL',
]) {
  assert.ok(
    sandboxDiagnosticScopeMigration.includes(fragment),
    `Sandbox diagnostic scope migration missing ${fragment}`,
  )
}

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
  "'carrier.credential.revealed'",
  'recordCarrierCredentialRevealInPostgres',
  'payload: { credentialVersion: row.credential_version }',
  'writeCarrierSandboxRateEvidenceInPostgres',
  'operations_carrier_rate_requests',
  "'carrier.sandbox_rate.succeeded'",
  "'carrier.sandbox_rate.failed'",
  'carrier-credential:',
  "$1::uuid, $2, 'carrier', $3, $4, 'disabled'",
  "WHEN account.status = 'error' THEN 'disabled'",
  'NOT $4::boolean',
  'carrierAccounts: OperationsCarrierAccountState[]',
  'operations_carrier_accounts',
  'createCarrierAccountInPostgres',
  'updateCarrierAccountInPostgres',
  'setCarrierAccountStatusInPostgres',
  'deleteCarrierAccountInPostgres',
  'readActiveCarrierAccountsFromPostgres',
  'encryptCarrierAccountNumber',
  'carrier_account_id',
  'billing_relationship',
  'billing_selection_snapshot',
  'sender_name',
  'senderName',
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
  'revealCarrierCredential',
  'recordCarrierCredentialRevealInPostgres',
  'expiresAt: new Date(revealedAt.getTime() + 30_000).toISOString()',
  "runtime.status !== 'active' || !runtime.verified",
  'await verifyCarrierCredential({ provider, environment, credential })',
  'encryptCarrierCredential(credential, organizationId, provider, environment)',
  'testCarrierSandboxRate',
  "environment !== 'sandbox'",
  'requestCarrierSandboxRates',
  'writeCarrierSandboxRateEvidenceInPostgres',
  'Carrier integration request failed',
  'createCarrierAccount',
  'updateCarrierAccount',
  'setCarrierAccountStatus',
  'deleteCarrierAccount',
  'sandboxBillingRelationship',
  "activeAccounts.length === 1",
  "'CARRIER_ACCOUNT_SELECTION_REQUIRED'",
  "precedence: ['sender', 'recipient', 'third_party']",
  'decryptCarrierAccountNumber',
  'carrierAccountGlobalId: selection.account.globalId',
  'billingRelationship: selection.relationship',
  'billingSelectionSnapshot: selection.snapshot',
  'senderName: selection.account.senderName',
]) {
  assert.ok(service.includes(fragment), `Carrier service contract missing ${fragment}`)
}
assert.ok(
  service.indexOf('await verifyCarrierCredential({ provider, environment, credential })')
    < service.indexOf('encryptCarrierCredential(credential, organizationId, provider, environment)'),
  'Carrier credentials must be verified before encryption and persistence',
)
assert.ok(
  service.match(/runtime\.status !== 'active' \|\| !runtime\.verified/g)?.length >= 2,
  'Credential resolution and sandbox rating must both require an active, verified account',
)
assert.ok(
  service.includes('accountNumber: null'),
  'Provider credentials must not persist a carrier billing account number',
)

const route = read('app_src/app/api/integrations/carriers/route.ts')
for (const fragment of [
  "export const runtime = 'nodejs'",
  '32 * 1024',
  'requireManager',
  "action === 'update-credential'",
  "action === 'reveal-credential'",
  "action === 'test-connection'",
  "action === 'test-sandbox-rate'",
  "action === 'set-enabled'",
  "action === 'disconnect'",
  "action === 'create-account'",
  "action === 'update-account'",
  "action === 'set-account-status'",
  "action === 'delete-account'",
  "'carrierAccountGlobalId'",
  "'senderName'",
  'sanitizedCarrierIntegrationError',
  'operationsCapabilities(actor).canManage',
  'canRevealCredentials: canRevealCredential(actor)',
  'requireCredentialViewer(actor)',
  "return role === 'owner' || role === 'admin'",
  "'CARRIER_CREDENTIAL_REVEAL_FORBIDDEN'",
  "'Cache-Control': 'no-store, max-age=0'",
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
  'Reveal credentials',
  'canRevealCredentials ?',
  'Visible for 30 seconds',
  'Copy client ID',
  'Copy client secret',
  'setRevealedCredential(null)',
  'Test sandbox rate',
  '101 Jegs Place',
  '101 Academy Drive',
  'Test Product',
  'Rating only',
  'Disconnect',
  'Billing accounts',
  'Sender: {entry.senderName}',
  'label="Sender name"',
  'Used as the shipper name for carrier rating and labels.',
  'Registered address line 1',
  'set-account-status',
  'delete-account',
  'Sandbox billing account',
  'carrierAccountGlobalId: selectedCarrierAccountGlobalId',
]) {
  assert.ok(panel.includes(fragment), `Carrier settings UI missing ${fragment}`)
}
assert.ok(
  panel.includes("account.status !== 'active'"),
  'Sandbox rate UI must remain disabled until the verified credential is explicitly enabled',
)
assert.ok(
  panel.includes("Math.max(0, Date.parse(revealedCredential.expiresAt) - Date.now())"),
  'Revealed credentials must be removed from the browser after their server-defined expiry',
)
const revealPersistence = persistence.slice(
  persistence.indexOf('export async function recordCarrierCredentialRevealInPostgres'),
  persistence.indexOf('async function auditCarrier'),
)
assert.ok(
  !/clientSecret|client_secret|credential_ciphertext|credential_iv|credential_tag/.test(revealPersistence),
  'Carrier reveal audit records must never read or include secret material',
)

const integrationsDoc = read('docs/modules/user-integrations.md')
for (const fragment of [
  'masked by default',
  'removed from the page after 30 seconds',
  'written to organization audit history before plaintext is returned',
  'users consuming delegated carrier rates cannot reveal the credential',
  'OAuth tokens remain non-exportable',
]) {
  assert.ok(integrationsDoc.includes(fragment), `Carrier reveal documentation missing ${fragment}`)
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
assert.equal(cryptoModule.normalizeCarrierBillingAccountNumber(' ACCT-9012 '), 'ACCT-9012')
assert.throws(
  () => cryptoModule.normalizeCarrierBillingAccountNumber('123'),
  /must be 4-128 printable ASCII characters/,
)

const carrierAccountAddress = {
  line1: '101 Jegs Place',
  line2: null,
  city: 'Delaware',
  region: 'OH',
  postalCode: '43015',
  countryCode: 'US',
}
const carrierAccountGlobalId = 'gac1234567'
const encryptedAccountNumber = cryptoModule.encryptCarrierAccountNumber(
  credential.accountNumber,
  organizationId,
  'ups_rest',
  'sandbox',
  carrierAccountGlobalId,
)
assert.ok(!encryptedAccountNumber.ciphertext.includes(Buffer.from(credential.accountNumber)))
assert.equal(
  cryptoModule.decryptCarrierAccountNumber(
    encryptedAccountNumber,
    organizationId,
    'ups_rest',
    'sandbox',
    carrierAccountGlobalId,
  ),
  credential.accountNumber,
)
assert.throws(
  () => cryptoModule.decryptCarrierAccountNumber(
    encryptedAccountNumber,
    organizationId,
    'ups_rest',
    'sandbox',
    'gac7654321',
  ),
  /could not be decrypted/,
  'carrier account AAD must reject a different account Global ID',
)
assert.equal(
  cryptoModule.carrierAccountAddressFingerprint(carrierAccountAddress),
  cryptoModule.carrierAccountAddressFingerprint({
    ...carrierAccountAddress,
    line1: '  101   Jegs Place ',
    postalCode: '43015-',
  }),
  'registered address fingerprints must use normalized address values',
)
assert.notEqual(
  cryptoModule.carrierAccountNumberFingerprint(
    organizationId,
    'ups_rest',
    'sandbox',
    credential.accountNumber,
  ),
  cryptoModule.carrierAccountNumberFingerprint(
    otherOrganizationId,
    'ups_rest',
    'sandbox',
    credential.accountNumber,
  ),
  'account number fingerprints must be tenant scoped',
)

const carrierServiceModule = loadTypeScriptModule('app_src/lib/integrations/carrierIntegrations.ts', {
  mocks: {
    '@/lib/integrations/carrierCredentialClient': {
      CarrierCredentialClientError: Error,
      verifyCarrierCredential: async () => ({}),
    },
    '@/lib/integrations/carrierSandboxRate': {
      CARRIER_SANDBOX_RATE_FIXTURE: {
        origin: {
          street: '101 Jegs Place',
          city: 'Delaware',
          state: 'OH',
          postalCode: '43015',
          countryCode: 'US',
        },
        destination: {
          street: '101 Academy Drive',
          city: 'Buzzards Bay',
          state: 'MA',
          postalCode: '02532',
          countryCode: 'US',
        },
      },
      carrierSandboxRateRequestEvidence: () => ({}),
      requestCarrierSandboxRates: async () => ({}),
    },
    '@/lib/integrations/carrierCredentialCrypto': cryptoModule,
    '@/lib/persistence/carrierIntegrations': {},
  },
})
const payerAccount = {
  registeredAddress: carrierAccountAddress,
  allowSenderBilling: true,
  allowRecipientBilling: true,
  allowThirdPartyBilling: true,
}
assert.equal(carrierServiceModule.sandboxBillingRelationship(payerAccount), 'sender')
assert.equal(carrierServiceModule.sandboxBillingRelationship({
  ...payerAccount,
  registeredAddress: {
    line1: '101 Academy Drive',
    line2: null,
    city: 'Buzzards Bay',
    region: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
}), 'recipient')
assert.equal(carrierServiceModule.sandboxBillingRelationship({
  ...payerAccount,
  registeredAddress: { ...carrierAccountAddress, line1: '500 Third Party Way' },
}), 'third_party')
assert.throws(
  () => carrierServiceModule.sandboxBillingRelationship({
    ...payerAccount,
    allowSenderBilling: false,
  }),
  (error) => error.code === 'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
  'a sender address must not silently fall through to recipient or third-party billing',
)

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

class MockCarrierCredentialClientError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const rateRequests = []
const sandboxRateModule = loadTypeScriptModule('app_src/lib/integrations/carrierSandboxRate.ts', {
  mocks: {
    '@/lib/integrations/carrierCredentialClient': {
      CarrierCredentialClientError: MockCarrierCredentialClientError,
      requestCarrierAccessToken: async () => ({
        accessToken: 'short-lived-rate-token-must-not-leak',
        expiresInSeconds: 3600,
        scope: 'rate',
      }),
    },
  },
})

const fixture = sandboxRateModule.CARRIER_SANDBOX_RATE_FIXTURE
assert.deepEqual(JSON.parse(JSON.stringify(fixture)), {
  origin: {
    name: 'John Doe',
    street: '101 Jegs Place',
    city: 'Delaware',
    state: 'OH',
    postalCode: '43015',
    countryCode: 'US',
  },
  destination: {
    name: 'John Doe',
    street: '101 Academy Drive',
    city: 'Buzzards Bay',
    state: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
  parcel: {
    description: 'Test Product',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  },
})

const fedexRate = await sandboxRateModule.requestCarrierSandboxRates({
  provider: 'fedex_rest',
  environment: 'sandbox',
  credential,
}, {
  senderName: 'Jegs Test Sender',
  fetchImpl: async (url, init) => {
    rateRequests.push({ url: String(url), init })
    return new Response(JSON.stringify({
      output: {
        rateReplyDetails: [{
          serviceType: 'FEDEX_GROUND',
          serviceName: 'FedEx Ground',
          ratedShipmentDetails: [{
            rateType: 'ACCOUNT',
            totalNetCharge: 14.72,
            currency: 'USD',
          }],
          operationalDetail: {
            transitTime: 'TWO_DAYS',
            deliveryDate: '2026-07-24',
          },
        }],
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-customer-transaction-id': 'fedex-rate-reference',
      },
    })
  },
})
assert.equal(rateRequests[0].url, 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes')
const fedexRequest = JSON.parse(rateRequests[0].init.body)
assert.equal(fedexRequest.accountNumber.value, credential.accountNumber)
assert.equal(fedexRequest.requestedShipment.shipper.contact.personName, 'Jegs Test Sender')
assert.equal(fedexRequest.requestedShipment.shipper.contact.companyName, 'Jegs Test Sender')
assert.equal(fedexRequest.requestedShipment.shipper.address.streetLines[0], '101 Jegs Place')
assert.equal(fedexRequest.requestedShipment.recipient.address.streetLines[0], '101 Academy Drive')
assert.equal(fedexRequest.requestedShipment.requestedPackageLineItems[0].itemDescription, 'Test Product')
assert.deepEqual(JSON.parse(JSON.stringify(fedexRate.result.rates)), [{
  serviceCode: 'FEDEX_GROUND',
  serviceName: 'FedEx Ground',
  amount: '14.72',
  currency: 'USD',
  rateType: 'ACCOUNT',
  transitDays: 2,
  deliveryDate: '2026-07-24',
}])
assert.equal(fedexRate.evidence.providerReference, 'fedex-rate-reference')
assert.equal(fedexRate.result.fixture.origin.name, 'Jegs Test Sender')

const upsRate = await sandboxRateModule.requestCarrierSandboxRates({
  provider: 'ups_rest',
  environment: 'sandbox',
  credential,
}, {
  senderName: 'Jegs Test Sender',
  fetchImpl: async (url, init) => {
    rateRequests.push({ url: String(url), init })
    return new Response(JSON.stringify({
      RateResponse: {
        RatedShipment: [{
          Service: { Code: '03' },
          TotalCharges: { MonetaryValue: '18.45', CurrencyCode: 'USD' },
          NegotiatedRateCharges: {
            TotalCharge: { MonetaryValue: '15.25', CurrencyCode: 'USD' },
          },
          TimeInTransit: {
            ServiceSummary: {
              EstimatedArrival: {
                BusinessDaysInTransit: '3',
                Arrival: { Date: '20260727' },
              },
            },
          },
        }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'transaction-id': 'ups-rate-reference' },
    })
  },
})
assert.equal(rateRequests[1].url, 'https://wwwcie.ups.com/api/rating/v2409/Shop')
const upsRequest = JSON.parse(rateRequests[1].init.body)
assert.equal(upsRequest.RateRequest.Request.RequestOption, 'Shop')
assert.equal(upsRequest.RateRequest.Shipment.Shipper.Name, 'Jegs Test Sender')
assert.equal(upsRequest.RateRequest.Shipment.ShipFrom.Name, 'Jegs Test Sender')
assert.equal(upsRequest.RateRequest.Shipment.Shipper.ShipperNumber, credential.accountNumber)
assert.equal(
  upsRequest.RateRequest.Shipment.PaymentDetails.ShipmentCharge[0].BillShipper.AccountNumber,
  credential.accountNumber,
)
assert.equal(upsRequest.RateRequest.Shipment.ShipFrom.Address.AddressLine[0], '101 Jegs Place')
assert.equal(upsRequest.RateRequest.Shipment.ShipTo.Address.AddressLine[0], '101 Academy Drive')
assert.equal(upsRequest.RateRequest.Shipment.Package[0].Description, 'Test Product')
assert.deepEqual(JSON.parse(JSON.stringify(upsRate.result.rates)), [{
  serviceCode: '03',
  serviceName: 'UPS Ground',
  amount: '15.25',
  currency: 'USD',
  rateType: 'NEGOTIATED',
  transitDays: 3,
  deliveryDate: '2026-07-27',
}])
assert.equal(upsRate.evidence.providerReference, 'ups-rate-reference')
assert.equal(upsRate.result.fixture.origin.name, 'Jegs Test Sender')

for (const value of [fedexRate, upsRate]) {
  const serialized = JSON.stringify(value)
  assert.ok(!serialized.includes(credential.accountNumber), 'Rate result/evidence must redact account numbers')
  assert.ok(!serialized.includes(credential.clientId), 'Rate result/evidence must redact client IDs')
  assert.ok(!serialized.includes(credential.clientSecret), 'Rate result/evidence must redact client secrets')
  assert.ok(!serialized.includes('short-lived-rate-token-must-not-leak'), 'Rate result/evidence must redact tokens')
}

await assert.rejects(
  sandboxRateModule.requestCarrierSandboxRates({
    provider: 'ups_rest',
    environment: 'production',
    credential,
  }),
  (error) => error.code === 'CARRIER_SANDBOX_REQUIRED' && error.status === 409,
  'Rating test must reject production carrier credentials before any provider request',
)

const sandboxRateSource = read('app_src/lib/integrations/carrierSandboxRate.ts')
for (const forbiddenEndpoint of [
  '/ship/v1/',
  '/pickup/',
  '/label/',
  '/manifest/',
]) {
  assert.ok(
    !sandboxRateSource.toLowerCase().includes(forbiddenEndpoint),
    `Sandbox rating adapter must not contain transactional endpoint ${forbiddenEndpoint}`,
  )
}

console.log('carrier integration contract tests passed')
