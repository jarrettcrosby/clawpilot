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

const cartonizationPackageRateMigration = read(
  'db/migrations/0136_operations_cartonization_package_rates.sql',
)
for (const fragment of [
  'DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_check',
  'ADD CONSTRAINT operations_carrier_rate_requests_purpose_valid',
  "'sandbox_rate_test'",
  "'cartonization_package_rate'",
]) {
  assert.ok(
    cartonizationPackageRateMigration.includes(fragment),
    `Cartonization package-rate migration missing ${fragment}`,
  )
}
const cartonizationShipmentRateMigration = read(
  'db/migrations/0143_operations_cartonization_shipment_rates.sql',
)
for (const fragment of [
  "'cartonization_shipment_rate'",
  "SET DEFAULT 'cartonization_shipment_rate'",
  'package_count NOT BETWEEN 1 AND 50',
  "rate.redacted_request #> '{shipment,parcels}'",
]) {
  assert.ok(
    cartonizationShipmentRateMigration.includes(fragment),
    `Cartonization shipment-rate migration missing ${fragment}`,
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
  "'carrier.cartonization_package_rate.succeeded'",
  "'carrier.cartonization_package_rate.failed'",
  "'carrier.cartonization_shipment_rate.succeeded'",
  "'carrier.cartonization_shipment_rate.failed'",
  'input.purpose',
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
  'configuration: row.configuration',
  'allowedCapabilities',
  'credentialRevealAllowed',
  'senderOriginWarehouseGlobalId',
  'CarrierIntegrationSourceManagedError',
  'lockedUserManagedCarrierConnection',
  'FOR UPDATE OF account',
  "configuration.managedBy === AG_ALCHEMY_EPISCS_RATING_DELEGATION",
  "configuration.authorizationScope === 'sandbox_rating_only'",
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
  'testCarrierSandboxShipmentRate',
  "environment !== 'sandbox'",
  'requestCarrierSandboxRates',
  'requestCarrierSandboxShipmentRates',
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
  'senderBillingOnly: true',
  'buildCarrierSandboxRateFixture',
  'buildCarrierSandboxShipmentRateFixture',
  'destination: input.destination',
  'parcel: input.parcel',
  "'cartonization_package_rate'",
  "'cartonization_shipment_rate'",
  'redactedSandboxRateBillingSelection',
  'requiresConfiguredCapability',
  'isSourceManagedCarrierConfiguration',
  'isExactAgAlchemyRatingDelegation',
  "'CARRIER_CAPABILITY_NOT_AUTHORIZED'",
  "runtime.configuration.credentialRevealAllowed === false",
  "'CARRIER_CREDENTIAL_REVEAL_NOT_ALLOWED'",
  "requiresConfiguredCapability(runtime, 'sandbox_rate')",
  "requiresConfiguredCapability(runtime, 'sandbox_label')",
  'requireUserManagedCarrierConnection',
  "'CARRIER_DELEGATION_SOURCE_MANAGED'",
  "sanitized.code !== 'CARRIER_DELEGATION_SOURCE_MANAGED'",
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
  "action === 'create-rate-test-label'",
  "action === 'print-rate-test-label'",
  "action === 'void-rate-test-label'",
  "action === 'close-rate-test-sample-label'",
  'requireExecutor(actor)',
  "'CARRIER_EXECUTE_REQUIRED'",
  'listOperationsPrinterProfilesInPostgres',
  'safeRateTestPrinter',
  'safeRateTestLabel',
  'error instanceof OperationsRequestError',
  "printer.connectionMode === 'local_agent'",
  "printer.localPrintAgentStatus === 'active'",
  "printer.supportedDocumentTypes.includes('shipping_label')",
  "'carrierAccountGlobalId'",
  "'destination'",
  "'parcel'",
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
const safeRateTestPrinterMapper = route.slice(
  route.indexOf('function safeRateTestPrinter'),
  route.indexOf('export async function GET'),
)
for (const forbidden of ['id: printer.id', 'warehouseId: printer.warehouseId']) {
  assert.ok(
    !safeRateTestPrinterMapper.includes(forbidden),
    `Carrier GET printer payload must not expose ${forbidden}`,
  )
}
assert.ok(
  safeRateTestPrinterMapper.includes('globalId: printer.globalId')
    && safeRateTestPrinterMapper.includes('warehouseGlobalId: printer.warehouseGlobalId'),
  'Carrier GET must identify compatible printers with safe global references',
)
const safeRateTestLabelMapper = route.slice(
  route.indexOf('function safeRateTestLabel'),
  route.indexOf('export async function GET'),
)
for (const forbidden of [
  'createAttemptGlobalId',
  'voidAttemptGlobalId',
  'carrierAccountGlobalId',
  'credentialVersion',
  'labelPayload',
]) {
  assert.ok(
    !safeRateTestLabelMapper.includes(forbidden),
    `Carrier GET label payload must not expose ${forbidden}`,
  )
}
assert.ok(
  safeRateTestLabelMapper.includes('contentSha256: label.contentSha256')
    && safeRateTestLabelMapper.includes('byteLength: label.byteLength'),
  'Carrier GET label history must expose safe integrity metadata without stored bytes',
)

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
  'canRevealCredentials && account?.credentialRevealAllowed !== false ?',
  'Visible for 30 seconds',
  'Copy client ID',
  'Copy client secret',
  'setRevealedCredential(null)',
  'Test sandbox rate',
  'Read-only sender',
  'Test destination',
  'Destination address line 1',
  'Destination address line 2',
  'Destination ZIP code',
  'Fixed parcel: {providerRateParcel.description}',
  'selectedUnitRateParcelDimensions',
  'selectedUnitRateParcelWeight',
  'Provider-native fixture (sent unchanged)',
  'Rating returns prices only',
  'No label media',
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
  'destination: rateDestination',
  'destinationFingerprint',
  'Sandbox label test workflow',
  "['Rate', 'Create label', 'Print stored label', 'Void / close']",
  "action: 'create-rate-test-label'",
  "action: 'print-rate-test-label'",
  "'void-rate-test-label'",
  "'close-rate-test-sample-label'",
  'rateEvidenceGlobalId: rateTest.evidenceGlobalId',
  'selectedRate.serviceCode',
  'Create and store sandbox label',
  'Test print stored label',
  'Void exact sandbox label',
  'Close UPS sample without carrier call',
  'Label metadata is durable and safe to review.',
  'Label bytes and internal database identifiers',
  'Printing queues the label bytes already stored in ClawPilot.',
  'It does not call the carrier,',
  "entry.connectionMode === 'local_agent'",
  "entry.localPrintAgentStatus === 'active'",
  "entry.supportedDocumentTypes.includes('shipping_label')",
  'EPISCS-managed sandbox rating',
  'ratingOnlyDelegation',
  'sourceManagedDelegation',
  'managedDelegationDrift',
  'Managed sandbox rating needs repair',
  'AG_ALCHEMY_EPISCS_RATING_DELEGATION',
  'account.managedBy === AG_ALCHEMY_EPISCS_RATING_DELEGATION',
  "account?.authorizationScope === 'sandbox_rating_only'",
  "account.allowedCapabilities[0] === 'sandbox_rate'",
  "account?.credentialRevealAllowed !== false",
  'Credentials, billing identity, labels, voids,',
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
const browserSafeRateTestLabel = panel.slice(
  panel.indexOf('type CarrierRateTestLabel ='),
  panel.indexOf('type CarrierRateTestPrinter ='),
)
for (const forbidden of ['labelPayload', 'providerLabelId', 'integrationAccountId', 'carrierAccountId']) {
  assert.ok(
    !browserSafeRateTestLabel.includes(forbidden),
    `Carrier browser label payload must not expose ${forbidden}`,
  )
}
assert.ok(
  browserSafeRateTestLabel.includes('contentSha256: string')
    && browserSafeRateTestLabel.includes('byteLength: number'),
  'Carrier browser label history may expose integrity metadata, not label bytes',
)
for (const fragment of [
  'The sandbox rating lane is already provisioned',
  'Managed rating identity',
  'Sensitive credentials and the full billing',
  'Run a sandbox rate check',
]) {
  assert.ok(panel.includes(fragment), `Delegated rating UX missing ${fragment}`)
}
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

let delegatedRevealAuditCount = 0
let delegatedCredentialVerificationCount = 0
let delegatedRateEvidenceCount = 0
const delegatedRateEvidenceInputs = []
const delegatedMutationCalls = []
let delegatedConfiguration = {
  authorizationScope: 'sandbox_rating_only',
  allowedCapabilities: ['sandbox_rate'],
  credentialRevealAllowed: false,
  managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
  senderOriginWarehouseGlobalId: 'gwh5366613',
}
const delegatedCarrierServiceModule = loadTypeScriptModule(
  'app_src/lib/integrations/carrierIntegrations.ts',
  {
    mocks: {
      '@/lib/integrations/carrierCredentialClient': {
        CarrierCredentialClientError: Error,
        verifyCarrierCredential: async () => {
          delegatedCredentialVerificationCount += 1
          return {}
        },
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
        buildCarrierSandboxRateFixture: ({ senderName, registeredAddress, destination }) => ({
          origin: { name: senderName, ...registeredAddress },
          destination,
          parcel: {
            description: 'Test Product',
            length: 12,
            width: 10,
            height: 6,
            dimensionUnit: 'IN',
            weight: 5,
            weightUnit: 'LB',
          },
        }),
        carrierSandboxRateRequestEvidence: () => ({}),
        requestCarrierSandboxRates: async () => ({
          result: {
            provider: 'ups_rest',
            environment: 'sandbox',
            status: 'online',
            rates: [{
              serviceCode: '03',
              serviceName: 'UPS Ground',
              amount: '10.00',
              currency: 'USD',
              rateType: null,
              transitDays: null,
              deliveryDate: null,
            }],
          },
          evidence: {
            requestHash: 'a'.repeat(64),
            redactedRequest: { purpose: 'sandbox_rate_test' },
            redactedResponse: { rateCount: 1 },
            providerReference: null,
            requestedAt: '2026-07-27T12:00:00.000Z',
            completedAt: '2026-07-27T12:00:01.000Z',
          },
        }),
      },
      '@/lib/integrations/carrierCredentialCrypto': cryptoModule,
      '@/lib/persistence/carrierIntegrations': {
        readCarrierRuntimeCredentialFromPostgres: async () => ({
          organizationId,
          integrationAccountId: '33333333-3333-4333-8333-333333333333',
          globalId: 'gia1234567',
          provider: 'ups_rest',
          environment: 'sandbox',
          status: 'active',
          verificationStatus: 'verified',
          credentialVersion: 1,
          configuration: delegatedConfiguration,
          encrypted,
        }),
        readActiveCarrierAccountsFromPostgres: async () => [{
          id: '44444444-4444-4444-8444-444444444444',
          globalId: carrierAccountGlobalId,
          integrationAccountId: '33333333-3333-4333-8333-333333333333',
          displayName: 'UPS sandbox rating account',
          senderName: 'Ag-Alchemy',
          accountNumberLastFour: credential.accountNumber.slice(-4),
          accountNumberFingerprint: 'b'.repeat(64),
          registeredAddress: {
            line1: '7009 S 108th St',
            line2: null,
            city: 'La Vista',
            region: 'NE',
            postalCode: '68128',
            countryCode: 'US',
          },
          registeredAddressFingerprint: 'c'.repeat(64),
          addressVerification: 'operator_attested',
          allowSenderBilling: true,
          allowRecipientBilling: false,
          allowThirdPartyBilling: false,
          encrypted: encryptedAccountNumber,
        }],
        recordCarrierCredentialRevealInPostgres: async () => {
          delegatedRevealAuditCount += 1
        },
        writeCarrierSandboxRateEvidenceInPostgres: async (input) => {
          delegatedRateEvidenceCount += 1
          delegatedRateEvidenceInputs.push(input)
          return 'grq1234567'
        },
        writeCarrierCredentialInPostgres: async () => delegatedMutationCalls.push('credential'),
        markCarrierCredentialVerificationInPostgres: async () => delegatedMutationCalls.push('verification'),
        createCarrierAccountInPostgres: async () => delegatedMutationCalls.push('create-account'),
        updateCarrierAccountInPostgres: async () => delegatedMutationCalls.push('update-account'),
        setCarrierAccountStatusInPostgres: async () => delegatedMutationCalls.push('account-status'),
        deleteCarrierAccountInPostgres: async () => delegatedMutationCalls.push('delete-account'),
        setCarrierIntegrationEnabledInPostgres: async () => delegatedMutationCalls.push('integration-status'),
        disconnectCarrierCredentialInPostgres: async () => delegatedMutationCalls.push('disconnect'),
      },
    },
  },
)
await assert.rejects(
  delegatedCarrierServiceModule.revealCarrierCredential({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    actorEmail: 'owner@example.com',
  }),
  (error) => (
    error.code === 'CARRIER_CREDENTIAL_REVEAL_NOT_ALLOWED'
    && error.status === 403
  ),
  'A rating-only delegated credential must not be revealable by the target organization',
)
assert.equal(
  delegatedRevealAuditCount,
  0,
  'A denied delegated reveal must not be recorded as a successful credential reveal',
)
await assert.rejects(
  delegatedCarrierServiceModule.resolveCarrierSandboxShippingRuntime({
    organizationId,
    provider: 'ups_rest',
  }),
  (error) => (
    error.code === 'CARRIER_CAPABILITY_NOT_AUTHORIZED'
    && error.status === 403
  ),
  'A rating-only delegated credential must not create or void sandbox labels',
)
for (const action of [
  () => delegatedCarrierServiceModule.testCarrierCredential({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.updateCarrierCredential({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    displayName: 'Blocked',
    clientId: 'replacement-client',
    clientSecret: 'replacement-secret',
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.createCarrierAccount({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    displayName: 'Blocked account',
    senderName: 'Ag-Alchemy',
    accountNumber: 'BLOCKED-1234',
    registeredAddress: carrierAccountAddress,
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.updateCarrierAccount({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    carrierAccountGlobalId,
    displayName: 'Blocked account',
    senderName: 'Ag-Alchemy',
    registeredAddress: carrierAccountAddress,
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.setCarrierAccountStatus({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    carrierAccountGlobalId,
    status: 'disabled',
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.deleteCarrierAccount({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    carrierAccountGlobalId,
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.setCarrierIntegrationEnabled({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    enabled: false,
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.disconnectCarrierCredential({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    actorEmail: 'owner@example.com',
  }),
]) {
  await assert.rejects(
    action,
    (error) => (
      error.code === 'CARRIER_DELEGATION_SOURCE_MANAGED'
      && error.status === 403
    ),
    'Every target-side delegated carrier mutation must be blocked',
  )
}
assert.deepEqual(
  delegatedMutationCalls,
  [],
  'Denied delegated actions must not reach a persistence mutation',
)
assert.equal(
  delegatedCredentialVerificationCount,
  0,
  'A target-side connection test must not call the provider or mutate verification state',
)
const delegatedRate = await delegatedCarrierServiceModule.testCarrierSandboxRate({
  organizationId,
  provider: 'ups_rest',
  environment: 'sandbox',
  carrierAccountGlobalId,
  destination: {
    name: 'John Doe',
    line1: '101 Academy Drive',
    line2: null,
    city: 'Buzzards Bay',
    region: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
  actorEmail: 'owner@example.com',
})
assert.equal(delegatedRate.evidenceGlobalId, 'grq1234567')
assert.equal(delegatedRate.carrierAccountGlobalId, carrierAccountGlobalId)
assert.equal(delegatedRateEvidenceCount, 1)
assert.equal(delegatedRateEvidenceInputs[0].purpose, 'sandbox_rate_test')

const delegatedCartonizationRate =
  await delegatedCarrierServiceModule.testCarrierSandboxRate({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    carrierAccountGlobalId,
    destination: {
      name: 'John Doe',
      line1: '101 Academy Drive',
      line2: null,
      city: 'Buzzards Bay',
      region: 'MA',
      postalCode: '02532',
      countryCode: 'US',
    },
    parcel: {
      description: 'AG12V2 optimized carton',
      exteriorInches: { length: 11, width: 9, height: 7 },
      grossPounds: 2.498,
    },
    actorEmail: 'owner@example.com',
  })
assert.equal(delegatedCartonizationRate.evidenceGlobalId, 'grq1234567')
assert.equal(delegatedRateEvidenceCount, 2)
assert.equal(
  delegatedRateEvidenceInputs[1].purpose,
  'cartonization_package_rate',
)

delegatedConfiguration = {
  authorizationScope: 'sandbox_rating_only',
  allowedCapabilities: ['sandbox_rate', 'sandbox_label'],
  credentialRevealAllowed: true,
  managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
  senderOriginWarehouseGlobalId: 'gwh5366613',
}
for (const driftedAction of [
  () => delegatedCarrierServiceModule.revealCarrierCredential({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    actorEmail: 'owner@example.com',
  }),
  () => delegatedCarrierServiceModule.resolveCarrierSandboxShippingRuntime({
    organizationId,
    provider: 'ups_rest',
  }),
  () => delegatedCarrierServiceModule.testCarrierSandboxRate({
    organizationId,
    provider: 'ups_rest',
    environment: 'sandbox',
    carrierAccountGlobalId,
    destination: {
      name: 'John Doe',
      line1: '101 Academy Drive',
      line2: null,
      city: 'Buzzards Bay',
      region: 'MA',
      postalCode: '02532',
      countryCode: 'US',
    },
    actorEmail: 'owner@example.com',
  }),
]) {
  await assert.rejects(
    driftedAction,
    (error) => (
      error.status === 403
      && (
        error.code === 'CARRIER_CREDENTIAL_REVEAL_NOT_ALLOWED'
        || error.code === 'CARRIER_CAPABILITY_NOT_AUTHORIZED'
      )
    ),
    'A drifted source-managed connection must fail closed',
  )
}
assert.equal(
  delegatedRateEvidenceCount,
  2,
  'A drifted source-managed connection must not write rate evidence',
)

delegatedConfiguration = {
  authorizationScope: 'sandbox_rating_only',
  credentialRevealAllowed: false,
}
await assert.rejects(
  delegatedCarrierServiceModule.resolveCarrierSandboxShippingRuntime({
    organizationId,
    provider: 'ups_rest',
  }),
  (error) => (
    error.code === 'CARRIER_CAPABILITY_NOT_AUTHORIZED'
    && error.status === 403
  ),
  'A partially drifted source-managed connection must not inherit legacy label capability',
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

const editableDestination = {
  name: '  Test   Receiver  ',
  line1: ' 500 Test Avenue ',
  line2: ' Suite 200 ',
  city: ' Columbus ',
  region: 'oh',
  postalCode: '43215-1234',
  countryCode: 'us',
}
const editableFixture = sandboxRateModule.buildCarrierSandboxRateFixture({
  senderName: 'Jegs Test Sender',
  registeredAddress: carrierAccountAddress,
  destination: editableDestination,
})
assert.deepEqual(JSON.parse(JSON.stringify(editableFixture)), {
  origin: {
    name: 'Jegs Test Sender',
    line1: '101 Jegs Place',
    line2: null,
    city: 'Delaware',
    region: 'OH',
    postalCode: '43015',
    countryCode: 'US',
  },
  destination: {
    name: 'Test Receiver',
    line1: '500 Test Avenue',
    line2: 'Suite 200',
    city: 'Columbus',
    region: 'OH',
    postalCode: '43215-1234',
    countryCode: 'US',
  },
  parcel: JSON.parse(JSON.stringify(fixture.parcel)),
})
const cartonizationParcel = {
  description: '  AG12V2   optimized carton  ',
  exteriorInches: {
    length: 11,
    width: 9,
    height: 7,
  },
  grossPounds: 2.498,
}
const cartonizationFixture = sandboxRateModule.buildCarrierSandboxRateFixture({
  senderName: 'Jegs Test Sender',
  registeredAddress: carrierAccountAddress,
  destination: editableDestination,
  parcel: cartonizationParcel,
})
assert.deepEqual(JSON.parse(JSON.stringify(cartonizationFixture.parcel)), {
  description: 'AG12V2 optimized carton',
  length: 11,
  width: 9,
  height: 7,
  dimensionUnit: 'IN',
  weight: 2.498,
  weightUnit: 'LB',
})
const secondCartonizationParcel = {
  description: '20lb optimized carton',
  exteriorInches: {
    length: 17,
    width: 11,
    height: 7,
  },
  grossPounds: 20.75,
}
const shipmentFixture =
  sandboxRateModule.buildCarrierSandboxShipmentRateFixture({
    senderName: 'Jegs Test Sender',
    registeredAddress: carrierAccountAddress,
    destination: editableDestination,
    parcels: [cartonizationParcel, secondCartonizationParcel],
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(shipmentFixture.parcels)),
  [
    JSON.parse(JSON.stringify(cartonizationFixture.parcel)),
    {
      description: '20lb optimized carton',
      length: 17,
      width: 11,
      height: 7,
      dimensionUnit: 'IN',
      weight: 20.75,
      weightUnit: 'LB',
    },
  ],
  'Multi-package fixtures must retain caller package order',
)
assert.equal(
  sandboxRateModule.MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES,
  50,
  'The whole-shipment bound must match the UPS Shop 50-package limit',
)
assert.equal(
  sandboxRateModule.carrierSandboxShipmentResponseLimitBytes(1),
  128 * 1024,
  'A one-package request must preserve the legacy response-size cap',
)
assert.ok(
  sandboxRateModule.carrierSandboxShipmentResponseLimitBytes(27)
    > 128 * 1024,
  'A 27-package response must receive a bounded proportional response cap',
)
assert.ok(
  sandboxRateModule.carrierSandboxShipmentResponseLimitBytes(50)
    <= 2 * 1024 * 1024,
  'The proportional response cap must retain a hard ceiling',
)
assert.equal(
  sandboxRateModule.buildCarrierSandboxShipmentRateFixture({
    senderName: 'Jegs Test Sender',
    registeredAddress: carrierAccountAddress,
    destination: editableDestination,
    parcels: Array.from({ length: 50 }, () => cartonizationParcel),
  }).parcels.length,
  50,
  'The UPS Shop boundary must accept exactly 50 ordered packages',
)
assert.throws(
  () => sandboxRateModule.buildCarrierSandboxShipmentRateFixture({
    senderName: 'Jegs Test Sender',
    registeredAddress: carrierAccountAddress,
    destination: editableDestination,
    parcels: Array.from({ length: 51 }, () => cartonizationParcel),
  }),
  /requires 1-50 ordered packages/,
  'Whole-shipment rating must fail closed above the UPS Shop limit',
)
assert.equal(
  sandboxRateModule.carrierSandboxRateRequestEvidence(
    'ups_rest',
    editableFixture,
  ).redactedRequest.purpose,
  'sandbox_rate_test',
  'Omitting a caller parcel must preserve the fixed diagnostic purpose',
)
for (const [invalidParcel, expected] of [
  [{ ...cartonizationParcel, unexpected: true }, /field is not supported/],
  [{
    description: cartonizationParcel.description,
    exteriorInches: { length: 11, width: 9 },
    grossPounds: 2.498,
  }, /field is required: height/],
  [{
    ...cartonizationParcel,
    exteriorInches: { length: '11', width: 9, height: 7 },
  }, /exterior length in inches must be a positive number/],
  [{ ...cartonizationParcel, grossPounds: 0 }, /gross weight in pounds must be a positive number/],
  [{ ...cartonizationParcel, grossPounds: 150.0001 }, /no greater than 150/],
  [{ ...cartonizationParcel, grossPounds: 2.4985 }, /at most three decimal places/],
  [{ ...cartonizationParcel, description: 'bad\u0000description' }, /must be plain text/],
]) {
  assert.throws(
    () => sandboxRateModule.normalizeCarrierSandboxParcel(invalidParcel),
    expected,
    'Caller-supplied parcels must use the exact canonical small-parcel shape',
  )
}
const destinationFingerprint = sandboxRateModule.carrierSandboxPartyFingerprint(
  editableFixture.destination,
)
assert.match(destinationFingerprint, /^[a-f0-9]{64}$/)
assert.equal(
  destinationFingerprint,
  sandboxRateModule.carrierSandboxPartyFingerprint({
    ...editableFixture.destination,
    name: ' Test   Receiver ',
    line1: ' 500   Test Avenue ',
  }),
  'party fingerprints must use the exact normalized canonical shape',
)
assert.equal(
  sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    region: 'Wisconsin',
  }).region,
  'WI',
  'provider-native US state names must normalize to carrier-ready postal codes',
)
assert.equal(
  sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    region: 'District of Columbia',
  }).region,
  'DC',
  'long US subdivision names must normalize before the two-letter boundary',
)
assert.notEqual(
  destinationFingerprint,
  sandboxRateModule.carrierSandboxPartyFingerprint({
    ...editableFixture.destination,
    postalCode: '43215',
  }),
  'party fingerprints must change when a normalized address field changes',
)
assert.throws(
  () => sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    unexpected: 'not allowed',
  }),
  /field is not supported/,
  'destination objects must reject unexpected nested fields',
)
assert.throws(
  () => sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    countryCode: 'CA',
  }),
  /supports US addresses only/,
  'sandbox rating destinations must remain US-only',
)
assert.throws(
  () => sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    postalCode: 'invalid',
  }),
  /five or nine digit US ZIP code/,
  'sandbox rating destinations must validate US ZIP codes',
)
assert.throws(
  () => sandboxRateModule.normalizeCarrierSandboxParty({
    ...editableFixture.destination,
    region: 'Not a state',
  }),
  /recognized US state or territory/,
  'unknown provider region names must fail with an actionable boundary',
)

const fedexRate = await sandboxRateModule.requestCarrierSandboxRates({
  provider: 'fedex_rest',
  environment: 'sandbox',
  credential,
}, {
  fixture: cartonizationFixture,
  purpose: 'cartonization_package_rate',
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
assert.deepEqual(fedexRequest.requestedShipment.recipient.address.streetLines, [
  '500 Test Avenue',
  'Suite 200',
])
assert.equal(
  fedexRequest.requestedShipment.requestedPackageLineItems[0].itemDescription,
  'AG12V2 optimized carton',
)
assert.deepEqual(
  fedexRequest.requestedShipment.requestedPackageLineItems[0].dimensions,
  { length: 11, width: 9, height: 7, units: 'IN' },
)
assert.deepEqual(
  fedexRequest.requestedShipment.requestedPackageLineItems[0].weight,
  { units: 'LB', value: 2.498 },
)
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
assert.equal(fedexRate.result.destinationFingerprint, destinationFingerprint)
assert.equal(fedexRate.result.purpose, 'cartonization_package_rate')
assert.equal(
  fedexRate.evidence.redactedRequest.purpose,
  'cartonization_package_rate',
)

const upsRate = await sandboxRateModule.requestCarrierSandboxRates({
  provider: 'ups_rest',
  environment: 'sandbox',
  credential,
}, {
  fixture: cartonizationFixture,
  purpose: 'cartonization_package_rate',
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
assert.deepEqual(upsRequest.RateRequest.Shipment.ShipTo.Address.AddressLine, [
  '500 Test Avenue',
  'Suite 200',
])
assert.equal(
  upsRequest.RateRequest.Shipment.Package[0].Description,
  'AG12V2 optimized carton',
)
assert.deepEqual(
  upsRequest.RateRequest.Shipment.Package[0].Dimensions,
  {
    UnitOfMeasurement: { Code: 'IN' },
    Length: '11',
    Width: '9',
    Height: '7',
  },
)
assert.deepEqual(
  upsRequest.RateRequest.Shipment.Package[0].PackageWeight,
  {
    UnitOfMeasurement: { Code: 'LBS' },
    Weight: '2.498',
  },
)
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
assert.equal(upsRate.result.destinationFingerprint, destinationFingerprint)
assert.equal(upsRate.result.purpose, 'cartonization_package_rate')
assert.equal(
  upsRate.evidence.redactedRequest.purpose,
  'cartonization_package_rate',
)

const fedexShipmentRate =
  await sandboxRateModule.requestCarrierSandboxShipmentRates({
    provider: 'fedex_rest',
    environment: 'sandbox',
    credential,
  }, {
    fixture: shipmentFixture,
    fetchImpl: async (url, init) => {
      rateRequests.push({ url: String(url), init })
      return new Response(JSON.stringify({
        padding: 'x'.repeat(135 * 1024),
        output: {
          rateReplyDetails: [{
            serviceType: 'FEDEX_GROUND',
            serviceName: 'FedEx Ground',
            ratedShipmentDetails: [{
              rateType: 'ACCOUNT',
              totalNetCharge: 31.47,
              currency: 'USD',
            }],
          }],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
const fedexShipmentRequest = JSON.parse(rateRequests[2].init.body)
assert.equal(
  fedexShipmentRequest.requestedShipment.totalPackageCount,
  2,
)
assert.equal(
  fedexShipmentRequest.requestedShipment.requestedPackageLineItems.length,
  2,
  'FedEx MPS must send one line item per physical package',
)
assert.deepEqual(
  fedexShipmentRequest.requestedShipment.requestedPackageLineItems.map(
    (item) => ({
      sequenceNumber: item.sequenceNumber,
      groupPackageCount: item.groupPackageCount,
      description: item.itemDescription,
    }),
  ),
  [
    {
      sequenceNumber: 1,
      groupPackageCount: 1,
      description: 'AG12V2 optimized carton',
    },
    {
      sequenceNumber: 2,
      groupPackageCount: 1,
      description: '20lb optimized carton',
    },
  ],
  'FedEx MPS line items must preserve cartonization package order without grouping',
)
assert.equal(fedexShipmentRate.result.packageCount, 2)
assert.equal(fedexShipmentRate.result.rates[0].amount, '31.47')
assert.equal(
  fedexShipmentRate.evidence.redactedResponse.rateScope,
  'multi_package_shipment',
)
assert.equal(fedexShipmentRate.evidence.redactedResponse.packageCount, 2)

const upsShipmentRate =
  await sandboxRateModule.requestCarrierSandboxShipmentRates({
    provider: 'ups_rest',
    environment: 'sandbox',
    credential,
  }, {
    fixture: shipmentFixture,
    fetchImpl: async (url, init) => {
      rateRequests.push({ url: String(url), init })
      return new Response(JSON.stringify({
        RateResponse: {
          RatedShipment: [{
            Service: { Code: '03' },
            NegotiatedRateCharges: {
              TotalCharge: {
                MonetaryValue: '29.15',
                CurrencyCode: 'USD',
              },
            },
          }],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
const upsShipmentRequest = JSON.parse(rateRequests[3].init.body)
assert.equal(upsShipmentRequest.RateRequest.Request.RequestOption, 'Shop')
assert.equal(upsShipmentRequest.RateRequest.Shipment.NumOfPieces, '2')
assert.equal(
  upsShipmentRequest.RateRequest.Shipment.Package.length,
  2,
  'UPS Shop must receive one ordered Package entry per physical package',
)
assert.deepEqual(
  upsShipmentRequest.RateRequest.Shipment.Package.map(
    (item) => item.Description,
  ),
  ['AG12V2 optimized carton', '20lb optimized carton'],
)
assert.equal(upsShipmentRate.result.rates[0].amount, '29.15')
for (const value of [
  fedexShipmentRate.evidence.redactedRequest,
  upsShipmentRate.evidence.redactedRequest,
]) {
  assert.equal(value.purpose, 'cartonization_shipment_rate')
  assert.equal(value.shipment.rateScope, 'multi_package_shipment')
  assert.equal(value.shipment.packageCount, 2)
  assert.deepEqual(
    JSON.parse(JSON.stringify(value.shipment.parcels)),
    JSON.parse(JSON.stringify(shipmentFixture.parcels)),
  )
  assert.equal(value.shipment.parcel, undefined)
}

for (const value of [
  fedexRate,
  upsRate,
  fedexShipmentRate,
  upsShipmentRate,
]) {
  const serialized = JSON.stringify(value)
  assert.ok(!serialized.includes(credential.accountNumber), 'Rate result/evidence must redact account numbers')
  assert.ok(!serialized.includes(credential.clientId), 'Rate result/evidence must redact client IDs')
  assert.ok(!serialized.includes(credential.clientSecret), 'Rate result/evidence must redact client secrets')
  assert.ok(!serialized.includes('short-lived-rate-token-must-not-leak'), 'Rate result/evidence must redact tokens')
}

for (const value of [fedexRate.evidence.redactedRequest, upsRate.evidence.redactedRequest]) {
  const serialized = JSON.stringify(value)
  assert.equal(value.shipment.destinationFingerprint, destinationFingerprint)
  assert.equal(
    value.shipment.originFingerprint,
    sandboxRateModule.carrierSandboxPartyFingerprint(editableFixture.origin),
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(value.shipment.parcel)),
    JSON.parse(JSON.stringify(cartonizationFixture.parcel)),
  )
  for (const pii of [
    editableFixture.origin.name,
    editableFixture.origin.line1,
    editableFixture.origin.city,
    editableFixture.origin.postalCode,
    editableFixture.destination.name,
    editableFixture.destination.line1,
    editableFixture.destination.line2,
    editableFixture.destination.city,
    editableFixture.destination.postalCode,
  ]) {
    assert.ok(!serialized.includes(pii), `Durable rate evidence must redact address value ${pii}`)
  }
}
assert.notEqual(
  fedexRate.evidence.requestHash,
  sandboxRateModule.carrierSandboxRateRequestEvidence('fedex_rest', {
    ...cartonizationFixture,
    destination: { ...cartonizationFixture.destination, postalCode: '43215' },
  }, 'cartonization_package_rate').requestHash,
  'the provider request hash must bind the exact normalized destination',
)

await assert.rejects(
  sandboxRateModule.requestCarrierSandboxRates({
    provider: 'ups_rest',
    environment: 'sandbox',
    credential,
  }, {
    fixture: cartonizationFixture,
    purpose: 'cartonization_shipment_rate',
  }),
  (error) => error.code === 'CARRIER_SHIPMENT_RATE_PATH_REQUIRED',
  'The legacy single-parcel path must reject whole-shipment purpose reuse',
)

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
