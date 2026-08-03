#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('./establish-ag-alchemy-carrier-sandbox.mjs', import.meta.url),
  'utf8',
)

for (const fragment of [
  `SOURCE_ORGANIZATION_NAME =
  'Express Parcel International DBA EPISCS'`,
  "TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'",
  "TARGET_WAREHOUSE_CODE = 'AG-ALCHEMY-01'",
  "TARGET_WAREHOUSE_GLOBAL_ID = 'gwh5366613'",
  "TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =\n  '750aa268-0e31-4065-a99c-4016e4d4fab1'",
  "EXPECTED_PROVIDERS = Object.freeze(['fedex_rest', 'ups_rest'])",
  'requireTrustedDevelopmentEnvironment()',
  "environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'",
  'loadDatabaseIdentity(client)',
  'Connected database is not the trusted ClawPilot development database',
  "accountOwnerType: 'operator_owned'",
  "authorizationScope: 'sandbox_rating_only'",
  "allowedCapabilities: ['sandbox_rate']",
  "authorizationScope: 'sandbox_fulfillment_diagnostic'",
  "allowedCapabilities: ['sandbox_rate', 'sandbox_label']",
  "'enable-ag-alchemy-carrier-sandbox-fulfillment-diagnostics-v1'",
  "process.argv.includes('--enable-sandbox-fulfillment')",
  'credentialRevealAllowed: false',
  'senderOriginWarehouseGlobalId: target.warehouse.global_id',
  "accountNumber: null",
  "'operator_attested', true, false, false, 'active'",
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'const lockedTarget = await loadTarget(client, true)',
  'targetSnapshotDigest(lockedTarget) !== targetSnapshotDigest(target)',
  "${lock ? 'FOR UPDATE' : ''}",
  'pg_advisory_xact_lock',
  '`carrier-credential:${target.organization.id}:${provider}:sandbox`',
  'FOR SHARE OF account, credential, carrier_account',
  'EPISCS source carrier records changed during delegation',
  'integrationConfiguration: row.configuration',
  'credentialVerificationStatus: row.verification_status',
  'if (value instanceof Date) return value.toISOString()',
  'integrationCredentialReference: row.credential_reference',
  'integrationUpdatedAt: row.integration_updated_at',
  'credentialCiphertextHash',
  'credentialIvHash',
  'credentialTagHash',
  'carrierAccountSenderName: row.sender_name',
  'carrierAccountCiphertextHash',
  'carrierAccountIvHash',
  'carrierAccountTagHash',
  'carrierAccountFingerprint: row.account_number_fingerprint',
  'carrierAccountEncryptionVersion',
  'carrierAccountStoredAddressFingerprint',
  'carrierAccountUpdatedAt: row.carrier_account_updated_at',
  'allowSenderBilling: row.allow_sender_billing',
  'allowRecipientBilling: row.allow_recipient_billing',
  'allowThirdPartyBilling: row.allow_third_party_billing',
  'registeredAddressFingerprint',
  'providerWrites: 0',
  'labelsCreated: 0',
]) {
  assert.ok(source.includes(fragment), `Carrier sandbox establishment missing ${fragment}`)
}

assert.ok(
  !source.includes('operations_carrier_rate_requests'),
  'Provisioning must not copy or create sandbox rate evidence',
)
assert.ok(
  !source.includes('operations_rate_test_labels'),
  'Provisioning must not copy or create carrier labels',
)
assert.ok(
  !source.includes('operations_shipments'),
  'Provisioning must not create operational shipments',
)
assert.ok(
  !source.includes('console.log(credential'),
  'Provisioning must not print credentials',
)
assert.ok(
  source.indexOf('verifySandboxCredential(source.provider, source.credential)')
    < source.indexOf('const result = await provision(client, sourceRows, target, apply, profile)'),
  'Both provider credentials must be verified before target writes',
)

assert.ok(
  source.indexOf("const profile = process.argv.includes('--enable-sandbox-fulfillment')")
    < source.indexOf('const requiredConfirmation = profile === SANDBOX_FULFILLMENT_PROFILE'),
  'Sandbox fulfillment diagnostics must require an explicit profile flag and separate confirmation',
)

console.log('AG Alchemy carrier sandbox establishment contract checks passed.')
