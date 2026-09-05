#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'

import {
  INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID,
  INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
  createIntegrationCredentialKeyAttestation,
  deriveIntegrationCredentialEncryptionKey,
  integrationCredentialKeyAttestationRecordDigest,
  resolveIntegrationCredentialEncryptionKeyConfig,
  verifyIntegrationCredentialKeyAttestation,
  verifyIntegrationCredentialKeyAttestationRecord,
} from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'
import {
  authenticateLegacyIntegrationCredentialAnchors,
  main as runIntegrationCredentialKeyAttestationOperator,
} from './integration-credential-key-attestation.mjs'

const databaseIdentity = '10000000-0000-4000-8000-000000000001'
const otherDatabaseIdentity = '20000000-0000-4000-8000-000000000002'
const keyMaterial = 'attestation-fixture-key-material-000000000000000001'
const wrongKeyMaterial = 'attestation-fixture-key-material-000000000000000002'
const keyId = 'prod-integrations-2026-09'
const createdAt = new Date('2026-09-05T12:00:00.000Z')

const generated = createIntegrationCredentialKeyAttestation({
  databaseIdentity,
  keyId,
  keyMaterial,
})
const record = {
  singleton_id: 1,
  attestation_version: generated.attestationVersion,
  database_identity: generated.databaseIdentity,
  key_id: generated.keyId,
  sentinel_ciphertext: generated.sentinelCiphertext,
  sentinel_iv: generated.sentinelIv,
  sentinel_tag: generated.sentinelTag,
  bootstrap_mode: 'empty',
  adoption_evidence_sha256: null,
  created_by: 'operator@example.com',
  created_at: createdAt,
}

const verified = verifyIntegrationCredentialKeyAttestationRecord({
  record,
  expectedDatabaseIdentity: databaseIdentity,
  keyId,
  keyMaterial,
})
assert.deepEqual(Object.keys(verified), [
  'status', 'keyId', 'recordDigest', 'databaseIdentity',
])
assert.deepEqual(verified, {
  status: 'verified',
  keyId,
  recordDigest: integrationCredentialKeyAttestationRecordDigest(record),
  databaseIdentity,
})
assert.match(verified.recordDigest, /^[a-f0-9]{64}$/u)

const config = resolveIntegrationCredentialEncryptionKeyConfig({
  environment: {
    RAILWAY_ENVIRONMENT_NAME: 'production',
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
  },
})
assert.deepEqual(Object.keys(config), ['hosted', 'mode', 'keyId'])
assert.deepEqual(JSON.parse(JSON.stringify(config)), {
  hosted: true,
  mode: 'integration',
  keyId,
})
assert.equal(config.getKeyMaterial(), keyMaterial)
assert.equal(config.getDerivedKey().byteLength, 32)
assert.equal(JSON.stringify(config).includes(keyMaterial), false)

const hostedAgentFallbackEnvironment = {
  RAILWAY_ENVIRONMENT_NAME: 'production',
  AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
}
assert.throws(
  () => resolveIntegrationCredentialEncryptionKeyConfig({
    environment: hostedAgentFallbackEnvironment,
  }),
  (error) => error.code
    === INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID,
  'Hosted runtime requires the dedicated integration credential key',
)
const adoptionFallback = resolveIntegrationCredentialEncryptionKeyConfig({
  environment: hostedAgentFallbackEnvironment,
  allowHostedLegacyAgentFallback: true,
})
assert.equal(
  adoptionFallback.mode,
  'hosted_legacy_adoption_agent_fallback',
)

const localFallback = resolveIntegrationCredentialEncryptionKeyConfig({
  environment: {
    AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
  },
})
assert.equal(localFallback.mode, 'agent_fallback')

await assert.rejects(
  runIntegrationCredentialKeyAttestationOperator(
    ['verify', '--expected-database-identity', databaseIdentity],
    {
      DATABASE_URL: 'postgresql://operator:test@db.example.test/clawpilot',
      AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
    },
  ),
  (error) => error.code
    === INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID,
  'operator commands must enforce hosted key resolution off-platform',
)

assert.throws(
  () => resolveIntegrationCredentialEncryptionKeyConfig({
    environment: {
      RAILWAY_ENVIRONMENT_NAME: 'production',
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    },
  }),
  (error) => {
    assert.equal(
      error.code,
      INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID,
    )
    assert.equal(error.message.includes(keyMaterial), false)
    return true
  },
)

function assertVerificationFailure(callback) {
  assert.throws(callback, (error) => {
    assert.equal(
      error.code,
      INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
    )
    assert.equal(
      error.message,
      'Integration credential key attestation verification failed',
    )
    assert.equal(error.message.includes(keyMaterial), false)
    assert.equal(error.message.includes(wrongKeyMaterial), false)
    return true
  })
}

assertVerificationFailure(() => verifyIntegrationCredentialKeyAttestationRecord({
  record,
  expectedDatabaseIdentity: databaseIdentity,
  keyId,
  keyMaterial: wrongKeyMaterial,
}))
assertVerificationFailure(() => verifyIntegrationCredentialKeyAttestationRecord({
  record,
  expectedDatabaseIdentity: otherDatabaseIdentity,
  keyId,
  keyMaterial,
}))
assertVerificationFailure(() => verifyIntegrationCredentialKeyAttestationRecord({
  record,
  expectedDatabaseIdentity: databaseIdentity,
  keyId: 'different-key-id',
  keyMaterial,
}))

for (const field of [
  'sentinel_ciphertext',
  'sentinel_iv',
  'sentinel_tag',
]) {
  const tampered = { ...record, [field]: Buffer.from(record[field]) }
  tampered[field][0] ^= 1
  assertVerificationFailure(() => verifyIntegrationCredentialKeyAttestationRecord({
    record: tampered,
    expectedDatabaseIdentity: databaseIdentity,
    keyId,
    keyMaterial,
  }))
}

const dbVerified = await verifyIntegrationCredentialKeyAttestation({
  client: { query: async () => ({ rows: [record] }) },
  secret: keyMaterial,
  keyId,
  expectedDatabaseIdentity: databaseIdentity,
})
assert.deepEqual(dbVerified, verified)

for (const rows of [[], [record, record]]) {
  await assert.rejects(
    verifyIntegrationCredentialKeyAttestation({
      client: { query: async () => ({ rows }) },
      secret: keyMaterial,
      keyId,
      expectedDatabaseIdentity: databaseIdentity,
    }),
    (error) => {
      assert.equal(
        error.code,
        INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
      )
      return true
    },
  )
}

const serializedRecord = JSON.stringify(record)
assert.equal(serializedRecord.includes(keyMaterial), false)
assert.equal(serializedRecord.includes(wrongKeyMaterial), false)

function encryptFixture(value, aad) {
  const key = deriveIntegrationCredentialEncryptionKey(keyMaterial)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(value, 'utf8')),
    cipher.final(),
  ])
  key.fill(0)
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

const webhookAad = (
  'clawpilot:commerce:gia0000001:shopify:'
  + 'fixture-event:orders/updated:webhook:v1'
)
const webhookFixture = encryptFixture('{"id":"fixture-order"}', webhookAad)
function footprintClient(webhookRow) {
  return {
    async query(sql) {
      return {
        rows: sql.includes('operations_commerce_webhook_receipts receipt')
          ? [webhookRow]
          : [],
      }
    },
  }
}
const authenticatedWebhook = await authenticateLegacyIntegrationCredentialAnchors(
  footprintClient({
    account_global_id: 'gia0000001',
    provider: 'shopify',
    provider_event_id: 'fixture-event',
    topic: 'orders/updated',
    ciphertext: webhookFixture.ciphertext,
    iv: webhookFixture.iv,
    tag: webhookFixture.tag,
  }),
  keyMaterial,
)
assert.equal(authenticatedWebhook.validated, 1)

const tamperedWebhookTag = Buffer.from(webhookFixture.tag)
tamperedWebhookTag[0] ^= 1
await assert.rejects(
  authenticateLegacyIntegrationCredentialAnchors(
    footprintClient({
      account_global_id: 'gia0000001',
      provider: 'shopify',
      provider_event_id: 'fixture-event',
      topic: 'orders/updated',
      ciphertext: webhookFixture.ciphertext,
      iv: webhookFixture.iv,
      tag: tamperedWebhookTag,
    }),
    keyMaterial,
  ),
  (error) => error.code === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
  'Non-credential key-backed ciphertext must be authenticated before adoption',
)

console.log('integration credential key attestation unit tests passed')
