#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const keyId = 'career-mail-test-v1'
const encryptionMaterial = 'career-mail-encryption-test-key-material-0123456789abcdef'
const fingerprintMaterial = 'career-mail-fingerprint-test-key-material-0123456789abcdef'

function loadCrypto() {
  const path = 'app_src/lib/careerSiteMailCrypto.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const configuration = {
    activeKeyId: keyId,
    keyIds: [keyId],
    getFingerprintKeyMaterial: () => fingerprintMaterial,
    getEncryptionKeyMaterial: (value) => value === keyId ? encryptionMaterial : null,
    hasEncryptionKey: (value) => value === keyId,
  }
  vm.runInNewContext(output, {
    Buffer,
    Error,
    JSON,
    Map,
    Object,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs') {
        return {
          resolveCommerceOrderRevisionEvidenceKeyConfig: () => configuration,
          summarizeCommerceOrderRevisionEvidenceKeyReadiness: (_configuration, options) => {
            const referencedKeyIds = [...new Set(options.referencedKeyIds)].sort()
            const missingReferencedKeyIds = referencedKeyIds.filter((value) => value !== keyId)
            return {
              ready: missingReferencedKeyIds.length === 0,
              activeKeyId: keyId,
              referencedKeyIds,
              missingReferencedKeyIds,
            }
          },
        }
      }
      if (specifier === '@/lib/persistence/config') return { isHostedRuntime: () => false }
      throw new Error(`Unexpected career mail crypto test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const crypto = loadCrypto()
const organizationId = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
const token = 'approval-capability-token-that-must-never-be-stored-in-plaintext-1234567890'
const request = {
  messageType: 'resume-approval-request',
  idempotencyKey: 'resume-request/0b43bb55-f85e-4492-ab4a-7f22582137e5',
  data: {
    requestId: '0b43bb55-f85e-4492-ab4a-7f22582137e5',
    name: 'Morgan Hiring Manager',
    email: 'morgan@example.com',
    organization: null,
    context: null,
    networkInterest: true,
    roleFit: false,
    variant: 'executive',
    approvalUrl: `https://jarrett.suburbiasandwichco.com/resume/approve?token=${token}`,
  },
}
const payloadHash = crypto.careerSiteMailPayloadFingerprint(request)
assert.match(payloadHash, /^[0-9a-f]{64}$/)
const identity = {
  sourceApp: 'jarrett-career-site',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  organizationId,
  payloadHash,
}
const encrypted = crypto.encryptCareerSiteMailPayload(request, identity)
assert.equal(encrypted.encryptionVersion, 1)
assert.equal(encrypted.keyId, keyId)
assert.equal(encrypted.iv.length, 12)
assert.equal(encrypted.tag.length, 16)
assert.equal(encrypted.ciphertext.includes(Buffer.from(token, 'utf8')), false)
assert.deepEqual(JSON.parse(JSON.stringify(crypto.decryptCareerSiteMailPayload(encrypted, {
  ...identity,
  messageType: request.messageType,
  idempotencyKey: request.idempotencyKey,
}))), request)
assert.throws(() => crypto.decryptCareerSiteMailPayload(encrypted, {
  ...identity,
  organizationId: '11111111-1111-4111-8111-111111111111',
  messageType: request.messageType,
  idempotencyKey: request.idempotencyKey,
}), /could not be decrypted/)
const tampered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) }
tampered.ciphertext[0] ^= 1
assert.throws(() => crypto.decryptCareerSiteMailPayload(tampered, {
  ...identity,
  messageType: request.messageType,
  idempotencyKey: request.idempotencyKey,
}), /could not be decrypted/)
assert.equal(crypto.careerSiteMailEncryptionKeyReadiness([keyId]).ready, true)
assert.deepEqual(
  [...crypto.careerSiteMailEncryptionKeyReadiness(['missing-key']).missingReferencedKeyIds],
  ['missing-key'],
)

console.log('Career-site mail encrypted-payload boundary verified')
