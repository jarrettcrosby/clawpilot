#!/usr/bin/env node

import assert from 'node:assert/strict'
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

function loadTypeScriptModule(path, mocks = {}) {
  const result = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (result.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(diagnostics.length, 0, `${path} must transpile without errors`)
  const loaded = { exports: {} }
  vm.runInNewContext(result.outputText, {
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

const managedEnvironmentNames = [
  'INTEGRATION_EVIDENCE_FINGERPRINT_KEY',
  'INTEGRATION_EVIDENCE_ACTIVE_KEY_ID',
  'INTEGRATION_EVIDENCE_ENCRYPTION_KEYS',
  'CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS',
  'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
  'AGENT_CREDENTIAL_ENCRYPTION_KEY',
  'APP_SESSION_SECRET',
]
const priorEnvironment = new Map(
  managedEnvironmentNames.map((name) => [name, process.env[name]]),
)

let hosted = true
const cryptoModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  {
    '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': await import(
      '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
    ),
    '@/lib/globalIds.mjs': {
      normalizeGlobalId(value, prefix) {
        const normalized = String(value || '').trim().toLowerCase()
        return normalized.startsWith(prefix) ? normalized : null
      },
    },
    '@/lib/persistence/config': {
      isHostedRuntime: () => hosted,
    },
  },
)
const evidenceModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
)
const railwayStart = readFileSync(
  resolve(root, 'scripts/start-railway.sh'),
  'utf8',
)
const runtimeConfig = readFileSync(
  resolve(root, 'scripts/validate-runtime-config.mjs'),
  'utf8',
)
const healthRoute = readFileSync(
  resolve(root, 'app_src/app/api/health/route.ts'),
  'utf8',
)
for (const requiredName of [
  'INTEGRATION_EVIDENCE_FINGERPRINT_KEY',
  'INTEGRATION_EVIDENCE_ACTIVE_KEY_ID',
  'INTEGRATION_EVIDENCE_ENCRYPTION_KEYS',
]) {
  assert.match(railwayStart, new RegExp(requiredName, 'u'))
}
assert.match(runtimeConfig, /resolveCommerceOrderRevisionEvidenceKeyConfig/u)
assert.match(healthRoute, /resolveCommerceOrderRevisionEvidenceKeyConfig/u)
assert.match(healthRoute, /summarizeCommerceOrderRevisionEvidenceKeyReadiness/u)
assert.match(healthRoute, /commerceRevisionEvidence/u)

const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia1234567'
const externalOrderId = 'gid://shopify/Order/123456789'
const sourceHash = 'a'.repeat(64)
const fingerprintKey = 'stable-revision-fingerprint-key-0000000000000001'
const encryptionKeyOne = 'revision-encryption-key-one-000000000000000001'
const encryptionKeyTwo = 'revision-encryption-key-two-000000000000000002'
const party = {
  contactName: 'Private Customer',
  email: 'private@example.com',
  externalIdentity: 'customer-123',
  phone: '+1 555 0100',
}

function configureRing(activeKeyId, keys) {
  process.env.INTEGRATION_EVIDENCE_FINGERPRINT_KEY = fingerprintKey
  process.env.INTEGRATION_EVIDENCE_ACTIVE_KEY_ID = activeKeyId
  process.env.INTEGRATION_EVIDENCE_ENCRYPTION_KEYS = JSON.stringify(keys)
  delete process.env.CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS
}

function fingerprint(value) {
  return cryptoModule.commerceOrderRevisionProtectedContentFingerprint(
    value,
    organizationId,
    accountGlobalId,
    externalOrderId,
    'party',
  )
}

function encrypt(value = party) {
  return cryptoModule.encryptCommerceOrderRevisionProtectedSnapshot(
    value,
    organizationId,
    accountGlobalId,
    externalOrderId,
    sourceHash,
    'party',
  )
}

function decrypt(fields, sourceHashValue = sourceHash) {
  return cryptoModule.decryptCommerceOrderRevisionProtectedSnapshot(
    fields,
    organizationId,
    accountGlobalId,
    externalOrderId,
    sourceHashValue,
    'party',
  )
}

try {
  for (const name of managedEnvironmentNames) delete process.env[name]
  assert.throws(
    () => fingerprint(party),
    /dedicated fingerprint key/u,
    'hosted revision evidence must not fall back to a rotating app secret',
  )
  process.env.INTEGRATION_EVIDENCE_FINGERPRINT_KEY = fingerprintKey
  assert.throws(
    () => encrypt(),
    /explicit active key ID/u,
    'hosted revision evidence requires an explicit active key ID and key ring',
  )

  configureRing('revision-k1', { 'revision-k1': encryptionKeyOne })
  const fingerprintOne = fingerprint(party)
  const encryptedOne = encrypt()
  assert.equal(encryptedOne.keyId, 'revision-k1')
  assert.equal(
    fingerprint(decrypt(encryptedOne)),
    fingerprintOne,
    'decrypted canonical plaintext must reproduce its immutable content HMAC',
  )
  assert.equal(
    fingerprint({
      phone: party.phone,
      externalIdentity: party.externalIdentity,
      email: party.email,
      contactName: party.contactName,
    }),
    fingerprintOne,
    'content HMAC must be stable across object key order',
  )

  const revisionHashOne = evidenceModule.commerceOrderRevisionHash({
    provider: 'shopify',
    sourceHash,
    order: { partyFingerprint: fingerprintOne },
  })
  configureRing('revision-k2', {
    'revision-k1': encryptionKeyOne,
    'revision-k2': encryptionKeyTwo,
  })
  const fingerprintTwo = fingerprint(party)
  const encryptedTwo = encrypt()
  assert.equal(encryptedTwo.keyId, 'revision-k2')
  assert.equal(fingerprintTwo, fingerprintOne)
  assert.equal(
    evidenceModule.commerceOrderRevisionHash({
      provider: 'shopify',
      sourceHash,
      order: { partyFingerprint: fingerprintTwo },
    }),
    revisionHashOne,
    'K1 to K2 encryption rotation must not change the provider revision hash',
  )
  assert.equal(decrypt(encryptedOne).email, party.email)
  assert.equal(decrypt(encryptedTwo).email, party.email)

  assert.throws(
    () => decrypt({ ...encryptedOne, keyId: 'revision-k2' }),
    /could not be decrypted/u,
    'a substituted key ID must fail AAD authentication',
  )
  assert.throws(
    () => decrypt({
      ...encryptedOne,
      ciphertext: Buffer.from(encryptedOne.ciphertext.map((byte, index) => (
        index === 0 ? byte ^ 1 : byte
      ))),
    }),
    /could not be decrypted/u,
    'ciphertext tampering must fail authentication',
  )
  assert.throws(
    () => decrypt(encryptedOne, 'b'.repeat(64)),
    /could not be decrypted/u,
    'whole-order source-hash AAD tampering must fail authentication',
  )

  configureRing('revision-k2', { 'revision-k2': encryptionKeyTwo })
  assert.equal(
    cryptoModule.commerceOrderRevisionEvidenceKeyAvailable('revision-k1'),
    false,
  )
  assert.throws(
    () => decrypt(encryptedOne),
    /could not be decrypted/u,
    'removing a referenced K1 makes its unpurged snapshot unavailable',
  )

  hosted = false
  for (const name of managedEnvironmentNames) delete process.env[name]
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = encryptionKeyOne
  assert.throws(
    () => fingerprint(party),
    /dedicated fingerprint key/u,
    'local legacy fallback is explicit rather than ambient',
  )
  process.env.CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS = '1'
  assert.match(fingerprint(party), /^[a-f0-9]{64}$/u)
  assert.equal(encrypt().keyId, 'legacy-v1')
} finally {
  for (const [name, value] of priorEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

console.log('Commerce order revision key-rotation acceptance passed')
